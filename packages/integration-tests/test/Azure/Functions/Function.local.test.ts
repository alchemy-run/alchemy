import * as Azure from "@alchemy.run/azure";
import * as blob from "@distilled.cloud/azure/storage-blob";
import * as queue from "@distilled.cloud/azure/storage-queue";
import * as web from "@distilled.cloud/azure/web";
import * as Alchemy from "alchemy";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schedule from "effect/Schedule";
import { onAzurite } from "../azurite.ts";
import { AsyncContainer, AsyncFunction } from "./fixtures/async-stack.ts";
import LocalFunction, { LocalFiles, LocalJobs } from "./fixtures/local-function.ts";

// `dev: true` runs the local providers behind the RPC sidecar, like `alchemy dev`.
const { test } = Test.make({ providers: Azure.providers(), dev: true });

class NotOk extends Data.TaggedError("NotOk")<{ status: number; body: string }> {}

/** `method url` until it answers `expected` (the process may still be starting). */
const call = (method: "GET" | "PUT" | "POST", url: string, expected: number, body?: string) =>
  Effect.gen(function* () {
    const request =
      method === "GET"
        ? HttpClientRequest.get(url)
        : (method === "PUT" ? HttpClientRequest.put(url) : HttpClientRequest.post(url)).pipe(
            HttpClientRequest.bodyText(body ?? "", "text/plain"),
          );
    const res = yield* HttpClient.execute(request);
    const text = yield* res.text;
    if (res.status !== expected) return yield* new NotOk({ status: res.status, body: text });
    return text;
  }).pipe(Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 20 }));

test.provider(
  "an Effect Function serves locally with blob, queue, and queue-trigger bindings on Azurite",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const fn = yield* LocalFunction;
          const files = yield* LocalFiles;
          const jobs = yield* LocalJobs;
          return { url: fn.url, functionAppId: fn.functionAppId, files, jobs };
        }),
      );

      // Local identities: a localhost URL and `dev:` ids, so no Azure call ran.
      expect(deployed.url).toMatch(/^http:\/\/localhost:\d+$/);
      expect(deployed.functionAppId).toMatch(/^dev:/);
      expect(deployed.files.containerId).toMatch(/^dev:/);
      expect(deployed.jobs.queueId).toMatch(/^dev:/);
      expect(deployed.files.storageAccount).toBe("devstoreaccount1");

      const home = JSON.parse(yield* call("GET", `${deployed.url}/`, 200));
      expect(home.greeting).toBe("hello from the local function");

      // Blob binding → Azurite, verified out of band.
      yield* call("PUT", `${deployed.url}/files/notes/a.txt`, 201, "local blob");
      expect(yield* call("GET", `${deployed.url}/files/notes/a.txt`, 200)).toBe("local blob");
      const stored = yield* onAzurite(({ blob: url }) =>
        blob.DownloadBlob({
          url,
          containerName: deployed.files.containerName,
          blob: "notes/a.txt",
        }),
      );
      expect(new TextDecoder().decode(stored.body)).toBe("local blob");

      // Queue binding → the local queue trigger → a blob the route reads back.
      const id = crypto.randomUUID();
      yield* call("POST", `${deployed.url}/jobs`, 202, JSON.stringify({ id, task: "resize" }));
      const recorded = yield* call("GET", `${deployed.url}/jobs/${id}`, 200).pipe(
        Effect.retry({ schedule: Schedule.spaced("1 second"), times: 30 }),
      );
      expect(JSON.parse(recorded)).toEqual({ id, task: "resize" });

      // The trigger deleted the message after its handler succeeded.
      const peeked = yield* onAzurite(({ queue: url }) =>
        queue.MessagesPeek({ url, queueName: deployed.jobs.queueName, numofmessages: 32 }),
      );
      expect(peeked).toEqual([]);

      yield* stack.destroy();

      // Destroy deleted the container and the queue from Azurite.
      const container = yield* onAzurite(({ blob: url }) =>
        blob.GetContainerProperties({ url, containerName: deployed.files.containerName }).pipe(
          Effect.as("found" as const),
          Effect.catchTag("ContainerNotFound", () => Effect.succeed("gone" as const)),
        ),
      );
      expect(container).toBe("gone");
      const jobsQueue = yield* onAzurite(({ queue: url }) =>
        queue.GetQueueProperties({ url, queueName: deployed.jobs.queueName }).pipe(
          Effect.as("found" as const),
          Effect.catchTag("QueueNotFound", () => Effect.succeed("gone" as const)),
        ),
      );
      expect(jobsQueue).toBe("gone");
    }),
  { timeout: 240_000 },
);

test.provider(
  "an async Function serves locally with its env",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const fn = yield* AsyncFunction;
          return { url: fn.url, functionAppId: fn.functionAppId };
        }),
      );
      expect(deployed.url).toMatch(/^http:\/\/localhost:\d+$/);
      expect(deployed.functionAppId).toMatch(/^dev:/);

      const body = JSON.parse(yield* call("POST", `${deployed.url}/greet?name=dev`, 200, "ping"));
      expect(body.message).toBe("hello dev");
      expect(body.secretLength).toBe(6);
      expect(body.container).toMatch(/^[a-z0-9-]+$/);
      expect(body.method).toBe("POST");
      expect(body.path).toBe("/greet");
      expect(body.body).toBe("ping");

      yield* stack.destroy();
    }),
  { timeout: 180_000 },
);

const siteStatus = (resourceGroupName: string, name: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* web.GetWebApp({ subscriptionId, resourceGroupName, name }).pipe(
      Effect.as("found" as const),
      Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], () =>
        Effect.succeed("gone" as const),
      ),
    );
  });

// ~$0 (Flex Consumption bills per execution); ~3 min.
test.provider(
  "Alchemy.remote() deploys the Function to Azure during dev",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const fn = yield* AsyncFunction;
          const container = yield* AsyncContainer;
          return {
            url: fn.url,
            name: fn.functionAppName,
            resourceGroup: fn.resourceGroup,
            functionAppId: fn.functionAppId,
            container: container.containerName,
            storageAccount: container.storageAccount,
          };
        }).pipe(Alchemy.remote()),
      );
      // Real identities: an ARM ID and an azurewebsites.net URL.
      expect(deployed.functionAppId).toMatch(/^\/subscriptions\//);
      expect(deployed.url).toMatch(/^https:\/\/.+\.azurewebsites\.net$/);
      expect(deployed.storageAccount).not.toBe("devstoreaccount1");
      expect(yield* siteStatus(deployed.resourceGroup, deployed.name)).toBe("found");

      const body = JSON.parse(
        yield* call("GET", `${deployed.url}/greet?name=remote`, 200).pipe(
          Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
        ),
      );
      expect(body.message).toBe("hello remote");
      expect(body.container).toBe(deployed.container);

      // Destroy deletes the live app (the row is stamped `live`).
      yield* stack.destroy();
      const after = yield* siteStatus(deployed.resourceGroup, deployed.name).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (status) => status === "gone",
          times: 12,
        }),
      );
      expect(after).toBe("gone");
    }),
  { timeout: 600_000 },
);
