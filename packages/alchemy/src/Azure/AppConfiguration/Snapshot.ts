import * as appconfiguration from "@distilled.cloud/azure/appconfiguration";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  isOwned,
  orUndefinedIfNotFound,
  userTags,
  waitForProvisioned,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

export interface SnapshotFilter {
  /** Key filter; a trailing `*` matches a prefix, e.g. `App:*`. */
  key: string;
  /** Label filter. Omit to match key-values without a label. */
  label?: string;
}

export interface SnapshotProps {
  /** Resource group of the configuration store. Changing it replaces the snapshot. */
  resourceGroup: string;
  /** Configuration store to snapshot. Changing it replaces the snapshot. */
  configurationStore: string;
  /**
   * Snapshot name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the snapshot.
   */
  name?: string;
  /**
   * Filters selecting the key-values captured (1-3 filters). Changing them
   * replaces the snapshot.
   */
  filters: SnapshotFilter[];
  /**
   * `Key` keeps one key-value per key (later filters win); `Key_Label`
   * keeps every key/label pair. Changing it replaces the snapshot.
   * @default "Key"
   */
  compositionType?: "Key" | "Key_Label";
  /**
   * Seconds an archived snapshot is kept before it expires. Changing it
   * replaces the snapshot.
   * @default the store's key-value revision retention period
   */
  retentionPeriod?: number;
  /**
   * Data-plane tags of the snapshot. Alchemy ownership tags are merged in.
   * Changing them replaces the snapshot.
   */
  tags?: Record<string, string>;
}

export interface Snapshot extends Resource<
  "Azure.AppConfiguration.Snapshot",
  SnapshotProps,
  {
    /** Name of the snapshot. */
    snapshotName: string;
    /** Configuration store that holds the snapshot. */
    configurationStore: string;
    /** Resource group of the configuration store. */
    resourceGroup: string;
    /** ARM resource ID of the snapshot. */
    snapshotId: string;
    /** Snapshot status (`Provisioning`, `Ready`, `Archived`, `Failed`). */
    status: string;
    /** Composition type. */
    compositionType: string;
    /** Number of key-values captured. */
    itemsCount: number;
    /** Size of the snapshot in bytes. */
    size: number;
    /** Creation time. */
    created: string | undefined;
    /** Expiry time (set once the snapshot is archived). */
    expires: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An immutable, point-in-time snapshot of key-values in an Azure App
 * Configuration store.
 *
 * Snapshots cannot be changed or deleted through Azure Resource Manager:
 * every prop change creates a new snapshot, and destroying the resource
 * only removes it from Alchemy state. The snapshot is deleted with its
 * store, or archives and then expires via the data-plane API.
 *
 * @see https://learn.microsoft.com/azure/azure-app-configuration/concept-snapshots
 *
 * ### Creating a Snapshot
 * **Example:** Snapshot of all `App:` keys
 * ```typescript
 * const snapshot = yield* Azure.AppConfiguration.Snapshot("release", {
 *   resourceGroup: group.resourceGroupName,
 *   configurationStore: store.configurationStoreName,
 *   filters: [{ key: "App:*" }],
 * });
 * ```
 *
 * **Example:** Snapshot keeping every label
 * ```typescript
 * const snapshot = yield* Azure.AppConfiguration.Snapshot("release", {
 *   resourceGroup: group.resourceGroupName,
 *   configurationStore: store.configurationStoreName,
 *   filters: [{ key: "*", label: "prod" }, { key: "*", label: "staging" }],
 *   compositionType: "Key_Label",
 *   retentionPeriod: 7 * 24 * 3600,
 * });
 * ```
 *
 * @resource
 */
export const Snapshot = Resource<Snapshot>("Azure.AppConfiguration.Snapshot");

const createSnapshotName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({
    id,
    maxLength: 256,
    lowercase: true,
  });
  return name.replace(/[^a-z0-9-_.]/g, "-");
});

const getSnapshot = (
  subscriptionId: string,
  resourceGroupName: string,
  configStoreName: string,
  snapshotName: string,
) =>
  orUndefinedIfNotFound(
    appconfiguration.GetSnapshot({
      subscriptionId,
      resourceGroupName,
      configStoreName,
      snapshotName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  configurationStore: string,
  name: string,
  snapshot: appconfiguration.Snapshot,
): Snapshot["Attributes"] => ({
  snapshotName: name,
  configurationStore,
  resourceGroup,
  snapshotId: snapshot.id ?? "",
  status: snapshot.properties?.status ?? "",
  compositionType: snapshot.properties?.compositionType ?? "",
  itemsCount: snapshot.properties?.itemsCount ?? 0,
  size: snapshot.properties?.size ?? 0,
  created: snapshot.properties?.created,
  expires: snapshot.properties?.expires,
  tags: userTags(snapshot.properties?.tags),
});

const canonicalFilters = (filters: ReadonlyArray<SnapshotFilter>) =>
  JSON.stringify(filters.map((f) => ({ key: f.key, label: f.label ?? null })));

const sameTags = (
  a: Record<string, string> | undefined,
  b: Record<string, string> | undefined,
) =>
  JSON.stringify(Object.entries(a ?? {}).sort()) ===
  JSON.stringify(Object.entries(b ?? {}).sort());

export const SnapshotProvider = () =>
  Provider.succeed(Snapshot, {
    stables: [
      "snapshotName",
      "configurationStore",
      "resourceGroup",
      "snapshotId",
      "compositionType",
      "created",
    ],

    // Snapshots live inside a store and have no ARM delete.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.configurationStore !== output.configurationStore ||
        (news.name !== undefined && news.name !== output.snapshotName) ||
        (news.compositionType ?? "Key") !== output.compositionType ||
        (olds !== undefined &&
          (canonicalFilters(news.filters) !== canonicalFilters(olds.filters) ||
            news.retentionPeriod !== olds.retentionPeriod ||
            !sameTags(news.tags, olds.tags)))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const store = output?.configurationStore ?? olds?.configurationStore;
      if (resourceGroup === undefined || store === undefined) return undefined;
      const name =
        output?.snapshotName ?? olds?.name ?? (yield* createSnapshotName(id));
      const observed = yield* getSnapshot(
        subscriptionId,
        resourceGroup,
        store,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, store, name, observed);
      return (yield* isOwned(id, observed.properties?.tags))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.AppConfiguration");
      const { resourceGroup, configurationStore } = news;
      const name =
        news.name ?? output?.snapshotName ?? (yield* createSnapshotName(id));
      const get = getSnapshot(
        subscriptionId,
        resourceGroup,
        configurationStore,
        name,
      );

      // Observe; ensure. Snapshots are immutable, so there is nothing to sync.
      const observed = yield* get;
      if (observed === undefined) {
        yield* appconfiguration.CreateSnapshot({
          subscriptionId,
          resourceGroupName: resourceGroup,
          configStoreName: configurationStore,
          snapshotName: name,
          properties: {
            filters: news.filters.map((f) => ({ key: f.key, label: f.label })),
            compositionType: news.compositionType ?? "Key",
            retentionPeriod: news.retentionPeriod,
            tags: yield* desiredTags(id, news.tags),
          },
        });
      }
      const ready = yield* waitForProvisioned(
        `app configuration snapshot ${name}`,
        get,
        (snapshot) => snapshot.properties?.provisioningState,
        { interval: "3 seconds", times: 40 },
      );
      return toAttrs(resourceGroup, configurationStore, name, ready);
    }),

    // ARM has no snapshot delete; the snapshot goes with its store or
    // archives and expires through the data-plane API.
    delete: Effect.fn(function* () {}),
  });
