/**
 * `alchemy dev` end to end for Azure: spawns the real CLI and drives the
 * local Function over HTTP. Storage runs on Azurite in Docker.
 *
 * Coverage, all local (no Azure credentials, no Azure resources):
 *   - Function URL  → `/` serves from `http://localhost:<port>`
 *   - env vars      → `/` echoes MY_VARIABLE through effect/Config
 *   - blob binding  → `/blob` put/get roundtrip, checked in Azurite out of band
 *   - queue binding → `/queue/send` sends; the local queue trigger records
 *                     the message as a blob, read back by `/queue/messages`
 *   - HOT RELOAD    → rewriting src/marker.ts restarts the Function on the
 *                     same URL with the new marker; restoring it swaps back
 *   - destroy       → `alchemy destroy` deletes the container and the queue
 */
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { azuriteEndpoints } from "@alchemy.run/azure/Storage/Azurite";
import { type Credentials, fromStaticToken } from "@distilled.cloud/azure";
import * as blob from "@distilled.cloud/azure/storage-blob";
import * as queue from "@distilled.cloud/azure/storage-queue";
import { DevCli, fetchOk } from "alchemy-test/DevCli";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";

const root = path.resolve(import.meta.dirname, "..");
const STAGE = "dev-cli-test";
// Credential-free dev: an empty alchemy home, CI mode (credentials from env
// only), and no Azure env credentials. The run must not need, or touch, a
// real Azure account.
const cli = new DevCli({
  root,
  stage: STAGE,
  env: {
    CI: "true",
    ALCHEMY_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "alchemy-azure-dev-")),
    ALCHEMY_PROFILE: undefined,
    AZURE_CLIENT_ID: undefined,
    AZURE_CLIENT_SECRET: undefined,
    AZURE_TENANT_ID: undefined,
    AZURE_SUBSCRIPTION_ID: undefined,
  },
});

const markerPath = path.join(root, "src", "marker.ts");
const markerSource = fs.readFileSync(markerPath, "utf8");

/** Run a distilled Storage call against Azurite, signed with its SAS. */
const azurite = <A, E>(
  call: (urls: {
    blob: string;
    queue: string;
  }) => Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const endpoints = yield* azuriteEndpoints;
      return yield* call({
        blob: `${endpoints.blob}?${endpoints.sas}`,
        queue: `${endpoints.queue}?${endpoints.sas}`,
      });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          fromStaticToken({ bearerToken: "azurite", subscriptionId: "" }),
          FetchHttpClient.layer,
        ),
      ),
    ),
  );

// The suite needs Docker (Azurite runs as a container).
const dockerAvailable = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;

afterAll(async () => {
  // Leave the tree clean, even after a failure mid-reload.
  fs.writeFileSync(markerPath, markerSource);
  const container = cli.outputValue("container");
  const queueName = cli.outputValue("queue");
  await cli.stop();
  if (process.env.NO_DESTROY || !dockerAvailable) return;
  cli.destroy();
  if (container !== undefined) {
    const found = await azurite(({ blob: url }) =>
      blob.GetContainerProperties({ url, containerName: container }).pipe(
        Effect.as(true),
        Effect.catchTag("ContainerNotFound", () => Effect.succeed(false)),
      ),
    );
    expect(found).toBe(false);
  }
  if (queueName !== undefined) {
    const found = await azurite(({ queue: url }) =>
      queue.GetQueueProperties({ url, queueName }).pipe(
        Effect.as(true),
        Effect.catchTag("QueueNotFound", () => Effect.succeed(false)),
      ),
    );
    expect(found).toBe(false);
  }
}, 180_000);

const readJson = async <T>(url: string | URL): Promise<T> =>
  (await (await fetchOk(url)).json()) as T;

/** Poll a route until `predicate` holds (the process may be restarting). */
const pollJson = <T>(what: string, url: string | URL, predicate: (value: T) => boolean) =>
  cli.pollUntil(
    what,
    async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) return undefined;
        const value = (await res.json()) as T;
        return predicate(value) ? value : undefined;
      } catch {
        return undefined; // mid-restart
      }
    },
    { tries: 240, delayMs: 500 },
  );

test.skipIf(!dockerAvailable)(
  "alchemy dev runs the Function locally with Storage on Azurite, with hot reload",
  async () => {
    cli.start();

    // The first run may pull the Azurite image and bundle the Function.
    const api = await cli.pollUntil("api url in stack outputs", () => cli.outputUrl("api"), {
      tries: 300,
      delayMs: 1000,
    });
    expect(new URL(api).hostname).toBe("localhost");
    expect(api).not.toContain("azurewebsites.net");
    expect(cli.outputValue("functionAppId")).toStartWith("dev:");
    expect(cli.outputValue("storageAccount")).toBe("devstoreaccount1");
    const container = await cli.pollUntil("container in stack outputs", () =>
      cli.outputValue("container"),
    );

    const home = await readJson<{ marker: string; variable: string }>(api);
    expect(home).toEqual({ marker: "azure-dev-marker-v1", variable: "my-variable-abc123" });

    const roundtrip = await readJson<{ text: string }>(new URL("/blob", api));
    expect(roundtrip.text).toBe("hello from blob storage");
    // Out of band: the blob is in Azurite.
    const stored = await azurite(({ blob: url }) =>
      blob.DownloadBlob({ url, containerName: container, blob: "hello.txt" }),
    );
    expect(new TextDecoder().decode(stored.body)).toBe("hello from blob storage");

    // Queue: send through the binding; the local queue trigger records it.
    const message = { id: crypto.randomUUID(), text: "hello from alchemy dev" };
    await fetchOk(new URL("/queue/send", api), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message),
    });
    const received = await pollJson<{ body: string | null }>(
      "queue message to be consumed",
      new URL(`/queue/messages?id=${message.id}`, api),
      (value) => value.body !== null,
    );
    expect(JSON.parse(received.body!)).toEqual(message);

    // HOT RELOAD: rewrite src/marker.ts with the CLI running. The watch
    // re-run sees a new bundle and restarts the process; the URL it was
    // reached on before keeps serving.
    fs.writeFileSync(
      markerPath,
      markerSource.replace("azure-dev-marker-v1", "azure-dev-marker-v2"),
    );
    await pollJson<{ marker: string }>(
      "restarted marker v2",
      api,
      (value) => value.marker === "azure-dev-marker-v2",
    );

    // Storage survived the restart: the consumed message is still there.
    const after = await readJson<{ body: string | null }>(
      new URL(`/queue/messages?id=${message.id}`, api),
    );
    expect(JSON.parse(after.body!)).toEqual(message);

    // Restore the marker (a second restart) and leave the tree clean.
    fs.writeFileSync(markerPath, markerSource);
    await pollJson<{ marker: string }>(
      "restored marker v1",
      api,
      (value) => value.marker === "azure-dev-marker-v1",
    );
  },
  { timeout: 600_000 },
);
