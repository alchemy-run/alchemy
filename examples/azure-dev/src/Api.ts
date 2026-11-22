import * as Azure from "@alchemy.run/azure";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { MARKER } from "./marker.ts";
import { Files, Jobs } from "./Storage.ts";

/** The blob where the queue consumer records job `id`. */
export const jobKey = (id: string) => `jobs/${id}.json`;

/**
 * One Azure Function with a blob container and a Storage queue. The same
 * code runs under `alchemy dev` (a local Node.js process, Storage on
 * Azurite) and `alchemy deploy` (Flex Consumption, real Storage):
 *
 * - `GET /` → `{ marker, variable }` (`MY_VARIABLE` through `effect/Config`)
 * - `GET /blob` → writes `hello.txt` and reads it back
 * - `POST /queue/send` → sends the JSON body to the queue
 * - `GET /queue/messages?id=` → what the consumer recorded for that id
 *
 * The consumer (`consumeQueueMessages`) is a queue trigger: on Azure the
 * Functions host runs it, locally the dev runtime polls the queue.
 */
export default class Api extends Azure.Functions.Function<Api>()(
  "Api",
  {
    main: import.meta.url,
    env: { MY_VARIABLE: "my-variable-abc123" },
  },
  Effect.gen(function* () {
    const filesContainer = yield* Files;
    const jobsQueue = yield* Jobs;
    const files = yield* Azure.Storage.BlobContainerReadWrite(filesContainer);
    const jobs = yield* Azure.Storage.QueueSend(jobsQueue);

    yield* Azure.Storage.consumeQueueMessages(jobsQueue, (message) => {
      const { id } = message.body as { id: string };
      return files
        .put(jobKey(id), JSON.stringify(message.body), { contentType: "application/json" })
        .pipe(Effect.orDie);
    });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");

        if (url.pathname === "/") {
          const variable = yield* Config.String("MY_VARIABLE");
          return yield* HttpServerResponse.json({ marker: MARKER, variable });
        }

        if (url.pathname === "/blob") {
          yield* files.put("hello.txt", "hello from blob storage");
          const blob = yield* files.get("hello.txt");
          return yield* HttpServerResponse.json({ text: blob?.text() ?? null });
        }

        if (url.pathname === "/queue/send" && request.method === "POST") {
          const body = yield* request.text;
          yield* jobs.send(body);
          return HttpServerResponse.empty({ status: 202 });
        }

        if (url.pathname === "/queue/messages") {
          const id = url.searchParams.get("id") ?? "";
          const blob = yield* files.get(jobKey(id));
          return yield* HttpServerResponse.json({ body: blob?.text() ?? null });
        }

        return HttpServerResponse.text("Not Found", { status: 404 });
      }).pipe(
        // A failed Azure call answers 502 with its tag, e.g. while the
        // role assignments propagate after the first deploy.
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
