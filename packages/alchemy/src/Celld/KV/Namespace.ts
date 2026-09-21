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
  type CatalogRecord,
} from "../ResourceCatalog.ts";

export interface NamespaceProps extends FleetResourceProps {
  /** Human-readable title; changing it does not move stored keys. */
  title?: string;
}

export interface Namespace extends Resource<
  "Celld.KV.Namespace",
  NamespaceProps,
  FleetResourceAttributes & {
    /** Stable fleet-scoped namespace identity used by the native binding. */
    namespaceId: string;
    /** Human-readable catalog title. */
    title: string;
  },
  never,
  Providers | CurrentFleet
> {}

export const isNamespace = (value: unknown): value is Namespace =>
  isResourceOfType(value, "Celld.KV.Namespace");

/**
 * A retained KV namespace selected by the ambient Fleet layer. Deleting the
 * declaration retains its keys and ownership claim. Renaming its title is safe;
 * changing fleets replaces the identity. Native data without a claim is not adopted.
 *
 * ### Creating a Namespace
 * **Example:** Declare a cache in the selected fleet
 * ```typescript
 * const cache = yield* Celld.KV.Namespace("Cache", { title: "Cache" });
 * ```
 *
 * @resource
 * @product Celld
 */
export const Namespace = withFleet(Resource<Namespace>("Celld.KV.Namespace"));

export const NamespaceProvider = () =>
  Provider.succeed(Namespace, {
    stables: ["namespaceId", "fleetId", "bucket"],
    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news)) return;
      if (news.fleetId !== olds.fleetId || !deepEqual(news.bucket, olds.bucket))
        return { action: "replace" } as const;
    }),
    read: Effect.fn(function* ({ fqn, instanceId, olds, output }) {
      const connection = yield* fleetConnection(output ?? olds);
      const namespaceId =
        output?.namespaceId ??
        (yield* createPhysicalName({ id: fqn, instanceId }));
      const record = yield* readCatalog(connection, "kv", namespaceId);
      if (!record) return undefined;
      const desired = {
        ...record,
        fleetId: connection.fleetId,
        owner: yield* catalogOwner(fqn, instanceId),
      };
      const attrs = { ...connection, namespaceId, title: record.label };
      return ownsCatalogRecord(record, desired) ? attrs : Unowned(attrs);
    }),
    reconcile: Effect.fn(function* ({ fqn, instanceId, news, output }) {
      const connection = yield* fleetConnection(news);
      const namespaceId =
        output?.namespaceId ??
        (yield* createPhysicalName({ id: fqn, instanceId }));
      const record: CatalogRecord = {
        version: 1,
        kind: "kv",
        physicalId: namespaceId,
        label: news.title ?? output?.title ?? namespaceId,
        fleetId: connection.fleetId,
        owner: yield* catalogOwner(fqn, instanceId),
        retained: false,
      };
      const observed = yield* ensureCatalog(connection, record);
      return {
        ...connection,
        namespaceId: observed.physicalId,
        title: observed.label,
      };
    }),
    delete: Effect.fn(function* ({ fqn, instanceId, output }) {
      yield* retainCatalog(output, {
        version: 1,
        kind: "kv",
        physicalId: output.namespaceId,
        label: output.title,
        fleetId: output.fleetId,
        owner: yield* catalogOwner(fqn, instanceId),
        retained: true,
      });
    }),
  });
