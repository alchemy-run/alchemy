import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { Events, Media } from "./resources.ts";
import AliasTarget from "./target.ts";

/** Use the exact names already declared by this Worker's env. */
export default class AliasConsumer extends Cloudflare.Worker<AliasConsumer>()(
  "AliasConsumer",
  {
    main: import.meta.url,
    env: { MEDIA: Media, EVENTS: Events, AUTH: AliasTarget },
  },
  Effect.gen(function* () {
    const media = yield* Media;
    const events = yield* Events;
    const read = yield* Cloudflare.R2.ReadBucket(media, { binding: "MEDIA" });
    const write = yield* Cloudflare.R2.WriteBucket(media, { binding: "MEDIA" });
    const readWrite = yield* Cloudflare.R2.ReadWriteBucket(media, { binding: "MEDIA" });
    const producer = yield* Cloudflare.Queues.WriteQueue(events, { binding: "EVENTS" });
    const sink = yield* Cloudflare.Queues.QueueSink(events, { binding: "EVENTS" });
    const auth = yield* Cloudflare.Workers.bindWorker(AliasTarget, { binding: "AUTH" });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://localhost").pathname;
        if (path === "/r2") {
          yield* write.put("alias-key", "aliased content");
          const object = yield* read.get("alias-key");
          const other = yield* readWrite.get("alias-key");
          return HttpServerResponse.text(`${yield* object!.text()}:${yield* other!.text()}`);
        }
        if (path === "/queue") {
          yield* producer.send("aliased event", { contentType: "text" });
          yield* Stream.succeed({ event: "aliased sink" }).pipe(Stream.run(sink));
          return HttpServerResponse.text("queue sent");
        }
        if (path === "/rpc") {
          return HttpServerResponse.text(yield* auth.greet("alice"));
        }
        if (path === "/env") {
          const env = yield* Cloudflare.Workers.WorkerEnvironment;
          return yield* HttpServerResponse.json({
            aliased: ["MEDIA", "EVENTS", "AUTH"].every((key) => key in env),
            extra: [media.LogicalId, events.LogicalId, AliasTarget.LogicalId].filter(
              (key) => key in env,
            ),
          });
        }
        return HttpServerResponse.text("unknown", { status: 404 });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed(
            HttpServerResponse.text(`AliasConsumer failed: ${String(cause)}`, { status: 500 }),
          ),
        ),
      ),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Cloudflare.R2.ReadBucketBinding,
        Cloudflare.R2.WriteBucketBinding,
        Cloudflare.R2.ReadWriteBucketBinding,
        Cloudflare.Queues.WriteQueueBinding,
        Cloudflare.Queues.QueueSinkBinding,
      ),
    ),
  ),
) {}
