import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

/** Docker repository whose image changes the consumer records. */
export const Watched = GCP.ArtifactRegistry.Repository("Watched", {
  location: "us-central1",
  format: "DOCKER",
});

/** Bucket the consumer records each delivered change in. */
export const ImageMarkers = GCP.Storage.Bucket("ImageMarkers", {
  location: "US-CENTRAL1",
  forceDestroy: true,
});

/**
 * Effect-native Cloud Run service consuming a repository's image changes,
 * recording each as `<action>/<digest>.json`.
 * Deployed from {@link ../RepositoryEventSource.test.ts}.
 */
export default class RepositoryEventsService extends GCP.Function<RepositoryEventsService>()(
  "RepositoryEventsService",
  { main: import.meta.url, location: "us-central1" },
  Effect.gen(function* () {
    const markers = yield* ImageMarkers;
    const putObject = yield* GCP.Storage.PutObject(markers);

    yield* GCP.ArtifactRegistry.consumeRepositoryEvents(Watched, (events) =>
      events.pipe(
        Stream.runForEach((event) =>
          putObject({
            name: `${event.action}/${(event.digest ?? "").split("@").at(-1)}.json`,
            body: JSON.stringify(event),
          }).pipe(Effect.orDie),
        ),
      ),
    );

    return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        GCP.ArtifactRegistry.RepositoryEventSourceLive.pipe(
          Layer.provideMerge(GCP.Run.TopicEventSource),
        ),
        GCP.Storage.PutObjectHttp,
      ),
    ),
  ),
) {}
