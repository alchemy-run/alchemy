import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { deepEqual, isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource, isResourceOfType } from "../../Resource.ts";
import {
  withFleet,
  type CurrentFleet,
  type FleetResourceProps,
  type FleetResourceAttributes,
} from "../FleetContext.ts";
import type { Providers } from "../Providers.ts";
import {
  catalogOwner,
  ensureCatalog,
  fleetConnection,
  ownsCatalogRecord,
  readCatalog,
  retainCatalog,
  ResourceCatalogError,
} from "../ResourceCatalog.ts";

export interface BucketProps extends FleetResourceProps {
  /** Fleet-scoped keyspace name. Omit to generate a unique physical name. */
  bucketName?: string;
}

export interface Bucket extends Resource<
  "Celld.R2.Bucket",
  BucketProps,
  FleetResourceAttributes & {
    /** Stable keyspace name inside the fleet's backing bucket, not a cloud bucket. */
    bucketName: string;
  },
  never,
  Providers | CurrentFleet
> {}

export const isBucket = (value: unknown): value is Bucket =>
  isResourceOfType(value, "Celld.R2.Bucket");

export const validateBucketName = (name: string) =>
  /^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,63}$/.test(name)
    ? Effect.void
    : Effect.fail(
        new ResourceCatalogError({
          reason: "configuration",
          message: `Invalid Celld bucket name '${name}': use 1–64 ASCII letters, digits, underscores or hyphens; the first character cannot be a hyphen.`,
        }),
      );

/**
 * A retained R2-compatible keyspace in the ambient fleet's backing bucket.
 * This does not create a cloud bucket. Renaming replaces the keyspace;
 * deletion retains all objects and its ownership claim. Unclaimed native
 * data and foreign retained claims cannot be automatically adopted.
 *
 * ### Creating a Bucket
 * **Example:** Declare a files keyspace in the selected fleet
 * ```typescript
 * const files = yield* Celld.R2.Bucket("Files", { bucketName: "files" });
 * ```
 *
 * @resource
 * @product Celld
 */
export const Bucket = withFleet(Resource<Bucket>("Celld.R2.Bucket"));

export const BucketProvider = () =>
  Provider.succeed(Bucket, {
    stables: ["bucketName", "fleetId", "bucket"],
    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return;
      if (
        news.fleetId !== olds.fleetId ||
        !deepEqual(news.bucket, olds.bucket) ||
        (news.bucketName !== undefined &&
          news.bucketName !== (output?.bucketName ?? olds.bucketName))
      )
        return { action: "replace" } as const;
    }),
    read: Effect.fn(function* ({ fqn, instanceId, olds, output }) {
      const connection = yield* fleetConnection(output ?? olds);
      const bucketName =
        output?.bucketName ??
        olds.bucketName ??
        (yield* createPhysicalName({ id: fqn, instanceId }));
      yield* validateBucketName(bucketName);
      const record = yield* readCatalog(connection, "r2", bucketName);
      if (!record) return undefined;
      const desired = {
        ...record,
        fleetId: connection.fleetId,
        owner: yield* catalogOwner(fqn, instanceId),
      };
      const attrs = { ...connection, bucketName };
      return ownsCatalogRecord(record, desired) ? attrs : Unowned(attrs);
    }),
    reconcile: Effect.fn(function* ({ fqn, instanceId, news, output }) {
      const connection = yield* fleetConnection(news);
      const bucketName =
        news.bucketName ??
        output?.bucketName ??
        (yield* createPhysicalName({ id: fqn, instanceId }));
      yield* validateBucketName(bucketName);
      const record = yield* ensureCatalog(connection, {
        version: 1,
        kind: "r2",
        physicalId: bucketName,
        label: bucketName,
        fleetId: connection.fleetId,
        owner: yield* catalogOwner(fqn, instanceId),
        retained: false,
      });
      return { ...connection, bucketName: record.physicalId };
    }),
    delete: Effect.fn(function* ({ fqn, instanceId, output }) {
      yield* retainCatalog(output, {
        version: 1,
        kind: "r2",
        physicalId: output.bucketName,
        label: output.bucketName,
        fleetId: output.fleetId,
        owner: yield* catalogOwner(fqn, instanceId),
        retained: true,
      });
    }),
  });
