import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { Events, Media } from "./resources.ts";
import AliasTarget from "./target.ts";

/** An Effect-native Worker that relies on the existing automatic binding names. */
export default class DefaultConsumer extends Cloudflare.Worker<DefaultConsumer>()(
  "DefaultConsumer",
  { main: import.meta.url },
  Effect.gen(function* () {
    const media = yield* Media;
    const events = yield* Events;
    const r2 = yield* Cloudflare.R2.ReadWriteBucket(media);
    const producer = yield* Cloudflare.Queues.WriteQueue(events);
    const target = yield* Cloudflare.Workers.bindWorker(AliasTarget);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://localhost").pathname;
        if (path === "/r2") {
          yield* r2.put("default-key", "default content");
          const object = yield* r2.get("default-key");
          return HttpServerResponse.text(yield* object!.text());
        }
        if (path === "/r2-cleanup") {
          yield* r2.delete("default-key");
          return HttpServerResponse.text("default object deleted");
        }
        if (path === "/queue") {
          yield* producer.send({ event: "default producer" });
          return HttpServerResponse.text("default queue sent");
        }
        if (path === "/rpc") {
          return HttpServerResponse.text(yield* target.greet("bob"));
        }
        if (path === "/env") {
          const env = yield* Cloudflare.Workers.WorkerEnvironment;
          return yield* HttpServerResponse.json({
            defaults: [media.LogicalId, events.LogicalId, AliasTarget.LogicalId].every(
              (key) => key in env,
            ),
            aliased: ["MEDIA", "EVENTS", "AUTH"].filter((key) => key in env),
          });
        }
        return HttpServerResponse.text("unknown", { status: 404 });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed(
            HttpServerResponse.text(`DefaultConsumer failed: ${String(cause)}`, { status: 500 }),
          ),
        ),
      ),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(Cloudflare.R2.ReadWriteBucketBinding, Cloudflare.Queues.WriteQueueBinding),
    ),
  ),
) {}
