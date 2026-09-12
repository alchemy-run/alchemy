import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Effect-native Cloud Run Service that binds Pub/Sub and Storage.
 * Deployed from {@link ../Service.test.ts}.
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
    const publish = yield* GCP.PubSub.Publish(tweets);
    const putObject = yield* GCP.Storage.PutObject(bucket);

    return {
      fetch: Effect.gen(function* () {
        yield* publish({
          body: { messages: [{ data: btoa("hello") }] },
        }).pipe(Effect.orDie);
        yield* putObject({
          name: "probe.txt",
          body: { name: "probe.txt", contentType: "text/plain" },
        }).pipe(Effect.orDie);
        return yield* HttpServerResponse.json({ published: true });
      }),
    };
  }).pipe(
    Effect.provide(GCP.PubSub.PublishHttp),
    Effect.provide(GCP.Storage.PutObjectHttp),
  ),
) {}
