import { createHash } from "node:crypto";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Store, StoredObject } from "../FleetStorage.ts";

/** An unsafe or unsupported deployment was refused before further publication. */
export class DeploymentError extends Data.TaggedError("Celld.DeploymentError")<{
  readonly reason:
    | "configuration"
    | "collision"
    | "ownership"
    | "locked"
    | "drift"
    | "unsupported"
    | "invalid-record";
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const refuse = (reason: DeploymentError["reason"], message: string) =>
  Effect.fail(new DeploymentError({ reason, message }));

/** Rust serde_json::Value sorts object keys, including integer-looking keys. */
export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return `{${Object.keys(value)
      .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(Reflect.get(value, key))}`,
      )
      .join(",")}}`;
  }
  throw new Error(
    "Deployment JSON must contain plain JSON values and safe integer numbers.",
  );
};

export const encode = (value: unknown) =>
  Effect.try({
    try: () => new TextEncoder().encode(canonicalJson(value)),
    catch: (cause) =>
      new DeploymentError({
        reason: "configuration",
        message: "Cannot encode deployment JSON.",
        cause,
      }),
  });
export const text = (body: Uint8Array) =>
  Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(body),
    catch: (cause) =>
      new DeploymentError({
        reason: "invalid-record",
        message: "Invalid UTF-8 object.",
        cause,
      }),
  });
export const bytes = (body: string) =>
  Effect.sync(() => new TextEncoder().encode(body));
export const digest = (body: Uint8Array) =>
  Effect.sync(() => createHash("sha256").update(body).digest("hex"));
export const equalBytes = (a: Uint8Array, b: Uint8Array) =>
  Effect.sync(
    () => a.length === b.length && a.every((byte, i) => byte === b[i]),
  );
export const decode = <A>(schema: Schema.Schema<A>, body: Uint8Array) =>
  Effect.try({
    try: () =>
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)),
    catch: (cause) =>
      new DeploymentError({
        reason: "invalid-record",
        message: "Invalid deployment JSON.",
        cause,
      }),
  }).pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(Schema.toType(schema), {
        onExcessProperty: "error",
      }),
    ),
    Effect.mapError(
      (cause) =>
        new DeploymentError({
          reason: "invalid-record",
          message: "Invalid deployment object; refusing to overwrite it.",
          cause,
        }),
    ),
  );
export const validate = <A>(schema: Schema.Schema<A>, value: unknown) =>
  Schema.decodeUnknownEffect(Schema.toType(schema))(value).pipe(
    Effect.mapError(
      (cause) =>
        new DeploymentError({
          reason: "configuration",
          message: "Invalid generated Celld artifact.",
          cause,
        }),
    ),
  );

/** A lost response is successful only when an observation proves the exact bytes landed. */
export const conditionalPut = (
  store: Store,
  key: string,
  body: Uint8Array,
  previous?: StoredObject,
) =>
  store
    .put(
      key,
      body,
      previous ? { ifMatch: previous.etag } : { ifNoneMatch: true },
    )
    .pipe(
      Effect.catchTag("Celld.FleetStorageError", (error) => {
        if (error.reason !== "transport" && error.reason !== "conflict")
          return Effect.fail(error);
        return Effect.gen(function* () {
          const observed = yield* store.get(key);
          if (observed && (yield* equalBytes(observed.body, body)))
            return { etag: observed.etag };
          return yield* Effect.fail(error);
        });
      }),
    );

export const ensureImmutable = (store: Store, key: string, body: Uint8Array) =>
  Effect.gen(function* () {
    const observed = yield* store.get(key);
    if (observed) {
      if (!(yield* equalBytes(observed.body, body)))
        return yield* refuse(
          "collision",
          `Immutable deployment object differs: ${key}`,
        );
      return { etag: observed.etag };
    }
    return yield* conditionalPut(store, key, body);
  });
