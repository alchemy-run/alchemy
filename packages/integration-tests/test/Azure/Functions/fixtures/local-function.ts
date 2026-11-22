import * as Azure from "@alchemy.run/azure";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { distilledFromSource } from "./distilled-source.ts";

// Resources of the `alchemy dev` fixture. Under dev they are local: Azurite
// holds the container and the queue.

export const LocalData = Azure.Storage.StorageAccount("LocalFnData");

export const LocalFiles = Effect.gen(function* () {
  const account = yield* LocalData;
  return yield* Azure.Storage.BlobContainer("LocalFnFiles", {
    storageAccount: account.storageAccountName,
  });
});

export const LocalJobs = Effect.gen(function* () {
  const account = yield* LocalData;
  return yield* Azure.Storage.Queue("LocalFnJobs", {
    storageAccount: account.storageAccountName,
  });
});

const FILE_ROUTE = /^\/files\/(.+)$/;
const JOB_ROUTE = /^\/jobs\/(.+)$/;

/**
 * Effect Function for the local-provider suite:
 *
 * - `GET /` → `{ greeting }` from `env`
 * - `PUT /files/:key`, `GET /files/:key` → the blob binding
 * - `POST /jobs` → the queue binding; the queue trigger writes `jobs/<id>`
 * - `GET /jobs/:id` → what the trigger wrote
 */
export default class LocalFunction extends Azure.Functions.Function<LocalFunction>()(
  "LocalFunction",
  {
    main: import.meta.url,
    env: { GREETING: "hello from the local function" },
    build: { input: { plugins: [distilledFromSource] } },
  },
  Effect.gen(function* () {
    const container = yield* LocalFiles;
    const jobs = yield* LocalJobs;
    const files = yield* Azure.Storage.BlobContainerReadWrite(container);
    const queue = yield* Azure.Storage.QueueSend(jobs);

    yield* Azure.Storage.consumeQueueMessages(jobs, (message) => {
      const body = message.body as { id: string };
      return files.put(`jobs/${body.id}`, JSON.stringify(message.body)).pipe(Effect.orDie);
    });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        if (url.pathname === "/") {
          const greeting = yield* Config.String("GREETING");
          return yield* HttpServerResponse.json({ greeting });
        }
        if (url.pathname === "/jobs" && request.method === "POST") {
          const message = yield* request.text;
          yield* queue.send(message);
          return HttpServerResponse.empty({ status: 202 });
        }
        const job = JOB_ROUTE.exec(url.pathname);
        if (job !== null) {
          const blob = yield* files.get(`jobs/${job[1]}`);
          return blob === undefined
            ? HttpServerResponse.text("Not Found", { status: 404 })
            : HttpServerResponse.text(blob.text());
        }
        const file = FILE_ROUTE.exec(url.pathname);
        if (file !== null && request.method === "PUT") {
          const body = yield* request.text;
          yield* files.put(file[1]!, body, { contentType: "text/plain" });
          return HttpServerResponse.empty({ status: 201 });
        }
        if (file !== null) {
          const blob = yield* files.get(file[1]!);
          return blob === undefined
            ? HttpServerResponse.text("Not Found", { status: 404 })
            : HttpServerResponse.text(blob.text());
        }
        return HttpServerResponse.text("Not Found", { status: 404 });
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed(HttpServerResponse.text(String(error._tag), { status: 502 })),
        ),
      ),
    };
  }).pipe(
    Effect.provide([
      Azure.Storage.BlobContainerReadWriteHttp,
      Azure.Storage.QueueSendHttp,
      Azure.Functions.StorageQueueEventSource,
    ]),
  ),
) {}
