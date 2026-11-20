import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

/** Database whose document changes the consumer records. */
export const Changes = GCP.Firestore.Database("Changes", {
  location: "us-central1",
  type: "FIRESTORE_NATIVE",
});

/** Bucket the consumer records each delivered change in. */
export const ChangeMarkers = GCP.Storage.Bucket("ChangeMarkers", {
  location: "US-CENTRAL1",
  forceDestroy: true,
});

/** Marker for one change: `<pattern>/<kind>/<document>.json`. */
export const marker = (pattern: string, kind: string, document: string) =>
  `${pattern}/${kind}/${document.replaceAll("/", "_")}.json`;

/**
 * Effect-native Cloud Run service consuming document changes through
 * Eventarc: created/updated/deleted on `items/{itemId}`, and `written` on
 * everything below `logs/`. Deployed from {@link ../DocumentEventSource.test.ts}.
 */
export default class DocumentEventsService extends GCP.Function<DocumentEventsService>()(
  "DocumentEventsService",
  { main: import.meta.url, location: "us-central1" },
  Effect.gen(function* () {
    const markers = yield* ChangeMarkers;
    const putObject = yield* GCP.Storage.PutObject(markers);
    const record = (pattern: string) => (event: GCP.Firestore.DocumentEvent) =>
      putObject({
        name: marker(pattern, event.kind, event.document),
        body: JSON.stringify(event),
      }).pipe(Effect.orDie);

    yield* GCP.Firestore.consumeDocumentEvents(
      Changes,
      { document: "items/{itemId}", kinds: ["created", "updated", "deleted"] },
      record("items"),
    );
    yield* GCP.Firestore.consumeDocumentEvents(
      Changes,
      { document: "logs/{path=**}", kinds: ["written"], path: "/__alchemy/eventarc/logs" },
      record("logs"),
    );

    return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        GCP.Firestore.DocumentEventSourceLive.pipe(Layer.provideMerge(GCP.Run.EventarcEventSource)),
        GCP.Storage.PutObjectHttp,
      ),
    ),
  ),
) {}
