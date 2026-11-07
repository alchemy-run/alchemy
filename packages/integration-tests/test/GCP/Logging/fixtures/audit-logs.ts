import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

/** Secret whose audit log entries the consumer records. */
export const Watched = GCP.SecretManager.Secret("Watched", {});

/** Bucket the consumer records each delivered entry in. */
export const Markers = GCP.Storage.Bucket("Markers", {
  location: "US-CENTRAL1",
  forceDestroy: true,
});

/** Methods the consumer subscribes to. */
export const METHODS = ["AddSecretVersion", "DisableSecretVersion"];

/** Marker object for one delivered entry: `<method>/<insertId>.json`. */
export const markerPrefix = (method: string) => `${method}/`;

/**
 * Effect-native Cloud Run service consuming a secret's audit log entries
 * over a Logging sink and Pub/Sub push, recording each as a marker object.
 * Deployed from {@link ../AuditLogEventSource.test.ts}.
 */
export default class AuditLogsService extends GCP.Function<AuditLogsService>()(
  "AuditLogsService",
  { main: import.meta.url, location: "us-central1" },
  Effect.gen(function* () {
    const markers = yield* Markers;
    const putObject = yield* GCP.Storage.PutObject(markers);

    yield* GCP.SecretManager.consumeSecretAuditLogs(Watched, { methods: METHODS }, (events) =>
      events.pipe(
        Stream.runForEach((event) =>
          putObject({
            name: `${markerPrefix(event.methodName.split(".").at(-1)!)}${event.insertId}.json`,
            body: JSON.stringify({
              serviceName: event.serviceName,
              methodName: event.methodName,
              resourceName: event.resourceName,
              principalEmail: event.principalEmail,
              logName: event.logName,
            }),
          }).pipe(Effect.orDie),
        ),
      ),
    );

    return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        GCP.Logging.AuditLogEventSourceLive.pipe(Layer.provideMerge(GCP.Run.TopicEventSource)),
        GCP.Storage.PutObjectHttp,
      ),
    ),
  ),
) {}
