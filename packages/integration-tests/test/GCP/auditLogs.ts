import type { AuditLogEvent } from "@alchemy.run/gcp/Logging/AuditLogEventSource";
import { makeObjectMedia } from "@alchemy.run/gcp/Storage/ObjectMedia";
import * as storage from "@distilled.cloud/gcp/storage_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

/**
 * Harness for the generated `consume<Resource>AuditLogs` event sources.
 *
 * Fixture side: {@link recordAuditLogs} writes each delivered entry as
 * `<key>/<method>/<insertId>.json` into a marker bucket. Test side:
 * {@link expectAuditEntry} makes an Admin Activity call on the resource
 * out of band and waits for its marker, repeating the call while the
 * sink's publisher grant on the topic propagates (entries written before
 * it lands are dropped).
 */

/** Short RPC method name: `google.….Service.SetIamPolicy` → `SetIamPolicy`. */
export const shortMethod = (methodName: string) => methodName.split(".").at(-1) ?? methodName;

/** Fixture side: record every entry under `key`. */
export const recordAuditLogs =
  <E, R>(
    key: string,
    putObject: (request: { name: string; body: string }) => Effect.Effect<unknown, E, R>,
  ) =>
  (events: Stream.Stream<AuditLogEvent>) =>
    events.pipe(
      Stream.runForEach((event) =>
        putObject({
          name: `${key}/${shortMethod(event.methodName)}/${event.insertId}.json`,
          body: JSON.stringify({
            serviceName: event.serviceName,
            methodName: event.methodName,
            resourceName: event.resourceName,
            logName: event.logName,
          }),
        }).pipe(Effect.orDie),
      ),
    );

class NotDeliveredYet extends Data.TaggedError("NotDeliveredYet")<{ key: string }> {}

/**
 * Test side: run `trigger` (an Admin Activity call logged as `method`)
 * until a marker for it appears under `key`, then return the recorded entry.
 */
export const expectAuditEntry = <E extends { readonly _tag: string }, R>(options: {
  bucket: string;
  key: string;
  method: string;
  trigger: Effect.Effect<unknown, E, R>;
}) =>
  Effect.gen(function* () {
    const prefix = `${options.key}/${options.method}/`;
    const marker = yield* Effect.gen(function* () {
      yield* options.trigger;
      yield* Effect.sleep("20 seconds");
      const { items = [] } = yield* storage.listObjects({ bucket: options.bucket, prefix });
      if (items.length === 0) return yield* new NotDeliveredYet({ key: options.key });
      return items[0]!;
    }).pipe(
      Effect.retry({
        while: (error) => error._tag === "NotDeliveredYet",
        schedule: Schedule.spaced("1 second"),
        times: 15,
      }),
    );
    const media = yield* makeObjectMedia;
    const object = yield* media.download({ bucket: options.bucket, object: marker.name! });
    return JSON.parse(new TextDecoder().decode(object.body)) as {
      serviceName: string;
      methodName: string;
      resourceName: string;
      logName: string;
    };
  });
