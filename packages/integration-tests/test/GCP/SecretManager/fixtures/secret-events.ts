import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

/** Secret whose notifications the consumer records. */
export const Notifying = GCP.SecretManager.Secret("Notifying", {});

/** Bucket the consumer records each delivered notification in. */
export const EventMarkers = GCP.Storage.Bucket("EventMarkers", {
  location: "US-CENTRAL1",
  forceDestroy: true,
});

/** Delivered event types; `SECRET_VERSION_ENABLE` is left out to prove the filter. */
export const EVENT_TYPES = [
  "SECRET_UPDATE",
  "SECRET_VERSION_ADD",
  "SECRET_VERSION_DISABLE",
  "SECRET_VERSION_DESTROY",
] as const;

/**
 * Effect-native Cloud Run service consuming a secret's notifications over
 * Pub/Sub push, recording each as `<eventType>/<messageId>.json`.
 * Deployed from {@link ../SecretEventSource.test.ts}.
 */
export default class SecretEventsService extends GCP.Function<SecretEventsService>()(
  "SecretEventsService",
  { main: import.meta.url, location: "us-central1" },
  Effect.gen(function* () {
    const markers = yield* EventMarkers;
    const putObject = yield* GCP.Storage.PutObject(markers);

    yield* GCP.SecretManager.consumeSecretEvents(
      Notifying,
      { eventTypes: [...EVENT_TYPES] },
      (events) =>
        events.pipe(
          Stream.runForEach((event) =>
            putObject({
              name: `${event.eventType}/${encodeURIComponent(event.publishTime)}.json`,
              body: JSON.stringify({
                eventType: event.eventType,
                secret: event.secret,
                version: event.version,
                resourceName: event.resource.name,
              }),
            }).pipe(Effect.orDie),
          ),
        ),
    );

    return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        GCP.SecretManager.SecretEventSourceLive.pipe(Layer.provideMerge(GCP.Run.TopicEventSource)),
        GCP.Storage.PutObjectHttp,
      ),
    ),
  ),
) {}
