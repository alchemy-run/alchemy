import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Effect-native Cloud Run Service that binds Pub/Sub, Memorystore, and
 * Storage. Deployed from {@link ../Service.test.ts}.
 */
export default class BoundService extends GCP.Function<BoundService>()(
  "BoundService",
  {
    main: import.meta.url,
    location: "us-central1",
    invokerIamDisabled: true,
  },
  Effect.gen(function* () {
    const tweets = yield* GCP.PubSub.Topic("tweets", {});
    const bucket = yield* GCP.Storage.Bucket("data", { forceDestroy: true });
    const cache = yield* GCP.Redis.Instance("Cache", { memorySizeGb: 1 });
    const publish = yield* GCP.PubSub.Publish(tweets);
    const redis = yield* GCP.Redis.ReadWriteRedis(cache);
    const putObject = yield* GCP.Storage.PutObject(bucket);

    return {
      fetch: Effect.gen(function* () {
        yield* redis.set("probe", "ok");
        const cached = yield* redis.get("probe");
        yield* publish({
          body: { messages: [{ data: btoa("hello") }] },
        });
        yield* putObject({
          name: "probe.txt",
          body: { name: "probe.txt", contentType: "text/plain" },
        });
        return yield* HttpServerResponse.json({
          redis: cached,
          published: true,
        });
      }),
    };
  }).pipe(
    Effect.provide(GCP.PubSub.PublishHttp),
    Effect.provide(GCP.Redis.ReadWriteRedisHttp),
    Effect.provide(GCP.Storage.PutObjectHttp),
  ),
) {}
