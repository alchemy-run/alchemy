import { createHash, createHmac } from "node:crypto";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { deepEqual } from "../Diff.ts";
import { Stack } from "../Stack.ts";
import { Stage } from "../Stage.ts";
import type {
  FleetResourceAttributes,
  FleetResourceProps,
} from "./FleetContext.ts";
import { FleetStorage, type Store } from "./FleetStorage.ts";

/** Only Alchemy metadata is written here; native cell and object keys are read-only. */
export const RESOURCE_CATALOG_PREFIX = "alchemy/resources/v1/";

const CatalogSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literals(["kv", "r2", "queue", "d1"]),
  physicalId: Schema.String,
  label: Schema.String,
  fleetId: Schema.String,
  owner: Schema.Struct({
    stack: Schema.String,
    stage: Schema.String,
    fqn: Schema.String,
    instanceId: Schema.String,
  }),
  retained: Schema.Boolean,
});

export type CatalogRecord = typeof CatalogSchema.Type;
export type CatalogKind = CatalogRecord["kind"];

/** Invalid metadata, a foreign claim, or native state without a managed claim. */
export class ResourceCatalogError extends Data.TaggedError(
  "Celld.ResourceCatalogError",
)<{
  readonly reason:
    | "configuration"
    | "invalid-record"
    | "ownership"
    | "unmanaged-data";
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const catalogKey = (kind: CatalogKind, physicalId: string) =>
  `${RESOURCE_CATALOG_PREFIX}${kind}/${encodeURIComponent(physicalId)}.json`;

export const catalogOwner = (fqn: string, instanceId: string) =>
  Effect.gen(function* () {
    const stack = yield* Stack;
    const stage = yield* Stage;
    return { stack: stack.name, stage, fqn, instanceId };
  });

export const fleetConnection = (props: FleetResourceProps) =>
  Effect.gen(function* () {
    if (!props.fleetId || !props.fleetUrl || !props.bucket?.uri) {
      return yield* Effect.fail(
        new ResourceCatalogError({
          reason: "configuration",
          message:
            "Persistent Celld resources require captured Fleet connection material. Provide Celld.Fleet.layer(Cells).",
        }),
      );
    }
    return {
      fleetId: props.fleetId,
      fleetUrl: props.fleetUrl,
      bucket: props.bucket,
      hostState: props.hostState,
    } satisfies FleetResourceAttributes;
  });

export const ownsCatalogRecord = (
  observed: CatalogRecord,
  desired: CatalogRecord,
) =>
  observed.fleetId === desired.fleetId &&
  deepEqual(observed.owner, desired.owner);

const decodeRecord = (body: Uint8Array) =>
  Effect.try({
    try: () => JSON.parse(new TextDecoder().decode(body)),
    catch: (cause) =>
      new ResourceCatalogError({
        reason: "invalid-record",
        message: "Invalid Celld resource catalog JSON.",
        cause,
      }),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(CatalogSchema)),
    Effect.mapError(
      (cause) =>
        new ResourceCatalogError({
          reason: "invalid-record",
          message:
            "Invalid Celld resource catalog record; refusing to overwrite it.",
          cause,
        }),
    ),
  );

const encodeRecord = (record: CatalogRecord) =>
  Effect.sync(() => new TextEncoder().encode(JSON.stringify(record)));

const observe = (store: Store, kind: CatalogKind, physicalId: string) =>
  Effect.gen(function* () {
    const object = yield* store.get(catalogKey(kind, physicalId));
    if (!object) return undefined;
    const record = yield* decodeRecord(object.body);
    if (record.kind !== kind || record.physicalId !== physicalId) {
      return yield* Effect.fail(
        new ResourceCatalogError({
          reason: "invalid-record",
          message:
            "Catalog key and resource identity disagree; refusing to overwrite it.",
        }),
      );
    }
    return { record, etag: object.etag };
  });

/** v0.5.0's shared cell ID derivation; used only to refuse unclaimed native data. */
export const nativeResourcePrefixes = (kind: CatalogKind, physicalId: string) =>
  Effect.sync(() => {
    if (kind === "r2") return [`r2/${physicalId}/`];
    const className =
      kind === "kv"
        ? "__KvNamespace"
        : kind === "d1"
          ? "__D1Database"
          : "__Queue";
    const namespace =
      kind === "kv"
        ? "cells:v1:kv:__KvNamespace"
        : kind === "d1"
          ? "cells:v1:d1:__D1Database"
          : "cells:v1:queue:__Queue";
    const key = createHash("sha256").update(namespace).digest();
    const name = kind === "kv" ? `${physicalId}/0` : physicalId;
    const first = createHmac("sha256", key)
      .update(name)
      .digest()
      .subarray(0, 16);
    const last = createHmac("sha256", key)
      .update(first)
      .digest()
      .subarray(0, 16);
    const scope = `${className}:${Buffer.concat([first, last]).toString("hex")}`;
    return [
      `cells/${scope}/`,
      ...(kind === "kv"
        ? [`kv/blobs/${scope}/`, `kv/blobs-v2/${scope}/`]
        : kind === "queue"
          ? [`deploy/queues/${physicalId}/`]
          : []),
    ];
  });

const refuseNativeData = (store: Store, desired: CatalogRecord) =>
  Effect.gen(function* () {
    const prefixes = yield* nativeResourcePrefixes(
      desired.kind,
      desired.physicalId,
    );
    for (const prefix of prefixes) {
      if ((yield* store.list(prefix)).length !== 0) {
        return yield* Effect.fail(
          new ResourceCatalogError({
            reason: "unmanaged-data",
            message: `Celld ${desired.kind} '${desired.physicalId}' has native state without an Alchemy claim. Automatic adoption is unsafe and is not supported.`,
          }),
        );
      }
    }
  });

const assertOwner = (record: CatalogRecord, desired: CatalogRecord) =>
  ownsCatalogRecord(record, desired)
    ? Effect.void
    : Effect.fail(
        new ResourceCatalogError({
          reason: "ownership",
          message: `Celld ${desired.kind} '${desired.physicalId}' is retained by '${record.owner.stack}/${record.owner.stage}/${record.owner.fqn}' (instance '${record.owner.instanceId}'). Transferring retained ownership, including --adopt, is not supported.`,
        }),
      );

export const readCatalog = (
  connection: FleetResourceAttributes,
  kind: CatalogKind,
  physicalId: string,
) =>
  Effect.gen(function* () {
    const storage = yield* FleetStorage;
    const store = yield* storage(connection);
    return (yield* observe(store, kind, physicalId))?.record;
  });

/** Observe, conditionally claim, then synchronize metadata without touching native data. */
export const ensureCatalog = (
  connection: FleetResourceAttributes,
  desired: CatalogRecord,
) =>
  Effect.gen(function* () {
    const storage = yield* FleetStorage;
    const store = yield* storage(connection);
    return yield* Effect.gen(function* () {
      const observed = yield* observe(store, desired.kind, desired.physicalId);
      if (observed) {
        yield* assertOwner(observed.record, desired);
        if (deepEqual(observed.record, desired)) return observed.record;
      } else {
        yield* refuseNativeData(store, desired);
      }
      yield* store.put(
        catalogKey(desired.kind, desired.physicalId),
        yield* encodeRecord(desired),
        observed ? { ifMatch: observed.etag } : { ifNoneMatch: true },
      );
      return desired;
    }).pipe(
      Effect.retry({
        times: 4,
        while: (error) =>
          error._tag === "Celld.FleetStorageError" &&
          error.reason === "conflict",
      }),
    );
  });

/** Declaration deletion only marks the durable claim retained; no backing data is deleted. */
export const retainCatalog = (
  connection: FleetResourceAttributes,
  desired: CatalogRecord,
) =>
  Effect.gen(function* () {
    const storage = yield* FleetStorage;
    const store = yield* storage(connection);
    yield* Effect.gen(function* () {
      const observed = yield* observe(store, desired.kind, desired.physicalId);
      if (!observed) return;
      yield* assertOwner(observed.record, desired);
      if (observed.record.retained) return;
      yield* store.put(
        catalogKey(desired.kind, desired.physicalId),
        yield* encodeRecord({ ...observed.record, retained: true }),
        { ifMatch: observed.etag },
      );
    }).pipe(
      Effect.retry({
        times: 4,
        while: (error) =>
          error._tag === "Celld.FleetStorageError" &&
          error.reason === "conflict",
      }),
    );
  });
