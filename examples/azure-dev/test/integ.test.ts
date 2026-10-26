/**
 * LIVE counterpart of test/dev.test.ts: deploys the same stack to Azure
 * (Test.make + deploy, no CLI) and drives the same routes against the real
 * function app. Together the two suites pin that the blob binding, the
 * queue binding, and the queue trigger behave the same under `alchemy dev`
 * (local process, Azurite) and a deploy (Flex Consumption, Azure Storage).
 *
 * Needs Azure credentials (`ALCHEMY_PROFILE=<name>`).
 */
import { expect } from "bun:test";
import * as Azure from "@alchemy.run/azure";
import * as storage from "@distilled.cloud/azure/storage";
import * as blob from "@distilled.cloud/azure/storage-blob";
import * as web from "@distilled.cloud/azure/web";
import * as Alchemy from "alchemy";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Test from "alchemy/Test/Bun";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import Stack from "../alchemy.run.ts";
import { jobKey } from "../src/Api.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
  profile: process.env.ALCHEMY_PROFILE,
});

/** The deployer's credentials, for out-of-band ARM and SAS calls. */
const azure = Layer.mergeAll(Azure.environmentFromAuthProvider(), Azure.fromAuthProvider()).pipe(
  Layer.provideMerge(Azure.AzureAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

// One Flex Consumption app (billed per execution) and two Standard_LRS
// storage accounts: about a cent per run, about 3 minutes to deploy.
const stack = beforeAll(deploy(Stack), { timeout: 900_000 });

class NotOk extends Data.TaggedError("NotOk")<{ readonly status: number; readonly body: string }> {}

/**
 * Call a route and expect `expected`. Retries through the cold start and the
 * role assignments propagating after the first deploy (the app answers 502
 * with the Azure error tag until then).
 */
const call = (method: "GET" | "POST", path: string, expected: number, body?: unknown) =>
  Effect.gen(function* () {
    const { api } = yield* stack;
    const url = `${String(api).replace(/\/+$/, "")}${path}`;
    const request =
      method === "POST"
        ? HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJsonUnsafe(body))
        : HttpClientRequest.get(url);
    const res = yield* HttpClient.execute(request);
    const text = yield* res.text;
    if (res.status !== expected) return yield* new NotOk({ status: res.status, body: text });
    return text;
  }).pipe(Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 36 }));

/** Where the stack's resources are, from its outputs. */
const where = Effect.gen(function* () {
  const outputs = yield* stack;
  const { subscriptionId } = yield* Azure.AzureEnvironment.current.pipe(Effect.provide(azure));
  return { ...outputs, subscriptionId };
});

type Where = Effect.Success<typeof where>;

/** The account's blob endpoint, signed with an account SAS listed through ARM. */
const sasUrl = (ids: Where) =>
  storage
    .ListStorageAccountAccountSAS({
      subscriptionId: ids.subscriptionId,
      resourceGroupName: ids.resourceGroup,
      accountName: ids.storageAccount,
      signedServices: "b",
      signedResourceTypes: "sco",
      signedPermission: "rl",
      signedProtocol: "https",
      signedExpiry: new Date(Date.now() + 3_600_000).toISOString(),
    })
    .pipe(
      Effect.map(
        ({ accountSasToken }) =>
          `https://${ids.storageAccount}.blob.core.windows.net/?${accountSasToken}`,
      ),
      Effect.provide(azure),
    );

const gone = () => Effect.succeed("gone" as const);

const siteStatus = (ids: Where) =>
  web
    .GetWebApp({
      subscriptionId: ids.subscriptionId,
      resourceGroupName: ids.resourceGroup,
      name: ids.functionAppName,
    })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], gone),
    );

const accountStatus = (ids: Where) =>
  storage
    .GetStorageAccountProperties({
      subscriptionId: ids.subscriptionId,
      resourceGroupName: ids.resourceGroup,
      accountName: ids.storageAccount,
    })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], gone),
    );

/** Poll until a deleted resource reads as gone. */
const untilGone = <E, R>(status: Effect.Effect<"found" | "gone", E, R>) =>
  status.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (current) => current === "gone",
      times: 24,
    }),
    Effect.provide(azure),
  );

afterAll.skipIf(!!process.env.NO_DESTROY)(
  Effect.gen(function* () {
    const ids = yield* where;
    yield* destroy(Stack);
    expect(yield* untilGone(siteStatus(ids))).toBe("gone");
    expect(yield* untilGone(accountStatus(ids))).toBe("gone");
  }),
  { timeout: 600_000 },
);

test(
  "the stack deploys a real function app and storage account",
  Effect.gen(function* () {
    const ids = yield* where;
    expect(String(ids.api)).toEndWith(".azurewebsites.net");
    expect(ids.functionAppId).toStartWith("/subscriptions/");
    expect(ids.storageAccount).not.toBe("devstoreaccount1");
    const site = yield* web
      .GetWebApp({
        subscriptionId: ids.subscriptionId,
        resourceGroupName: ids.resourceGroup,
        name: ids.functionAppName,
      })
      .pipe(Effect.provide(azure));
    expect(site.kind).toContain("functionapp");
    expect(site.identity?.type).toBe("SystemAssigned");
  }),
  { timeout: 120_000 },
);

test(
  "serves the marker and env",
  Effect.gen(function* () {
    const home = JSON.parse(yield* call("GET", "/", 200));
    expect(home).toEqual({ marker: "azure-dev-marker-v1", variable: "my-variable-abc123" });
  }),
  { timeout: 300_000 },
);

test(
  "the blob binding roundtrips, and the blob is in the real container",
  Effect.gen(function* () {
    const ids = yield* where;
    const res = JSON.parse(yield* call("GET", "/blob", 200));
    expect(res.text).toBe("hello from blob storage");
    const url = yield* sasUrl(ids);
    const stored = yield* blob
      .DownloadBlob({ url, containerName: ids.container, blob: "hello.txt" })
      .pipe(Effect.provide(azure));
    expect(new TextDecoder().decode(stored.body)).toBe("hello from blob storage");
  }),
  { timeout: 300_000 },
);

test(
  "a sent message reaches the queue trigger",
  Effect.gen(function* () {
    const ids = yield* where;
    const message = { id: crypto.randomUUID(), text: "hello from azure" };
    yield* call("POST", "/queue/send", 202, message);
    const recorded = yield* call("GET", `/queue/messages?id=${message.id}`, 200).pipe(
      Effect.map((text) => (JSON.parse(text) as { body: string | null }).body),
      Effect.repeat({
        schedule: Schedule.spaced("5 seconds"),
        until: (body) => body !== null,
        times: 48,
      }),
    );
    expect(JSON.parse(recorded!)).toEqual(message);
    // Out of band: the consumer wrote the record blob.
    const url = yield* sasUrl(ids);
    const stored = yield* blob
      .DownloadBlob({ url, containerName: ids.container, blob: jobKey(message.id) })
      .pipe(Effect.provide(azure));
    expect(JSON.parse(new TextDecoder().decode(stored.body))).toEqual(message);
  }),
  { timeout: 420_000 },
);
