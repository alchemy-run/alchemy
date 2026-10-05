import * as appconfiguration from "@distilled.cloud/azure/appconfiguration";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  stackAndStage,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { getConfigurationStore } from "./ConfigurationStore.ts";

export interface ReplicaProps {
  /** Resource group of the configuration store. Changing it replaces the replica. */
  resourceGroup: string;
  /** Configuration store to replicate. Changing it replaces the replica. */
  configurationStore: string;
  /**
   * Azure location of the replica; must differ from the store's location
   * and from every other replica. Changing it replaces the replica.
   */
  location: string;
  /**
   * Replica name: up to 50 letters and digits, and at most 60 characters
   * together with the store name. If omitted, a unique name is generated
   * from the app, stage, and logical ID. Changing it replaces the replica.
   */
  name?: string;
}

export interface Replica extends Resource<
  "Azure.AppConfiguration.Replica",
  ReplicaProps,
  {
    /** Name of the replica. */
    replicaName: string;
    /** Configuration store the replica belongs to. */
    configurationStore: string;
    /** Resource group of the configuration store. */
    resourceGroup: string;
    /** Location of the replica. */
    location: string;
    /** ARM resource ID of the replica. */
    replicaId: string;
    /** Data-plane endpoint of the replica, e.g. `https://<store>-<replica>.azconfig.io`. */
    endpoint: string;
  },
  never,
  Providers
> {}

/**
 * A geo-replica of an Azure App Configuration store in another region.
 * Requires a `Standard` or `Premium` store.
 *
 * Replicas cannot be tagged; Alchemy treats a replica as owned when its
 * store carries the current stack's ownership tags.
 *
 * @see https://learn.microsoft.com/azure/azure-app-configuration/concept-geo-replication
 *
 * ### Replicating a Store
 * **Example:** Replica in a second region
 * ```typescript
 * const store = yield* Azure.AppConfiguration.ConfigurationStore("config", {
 *   resourceGroup: group.resourceGroupName,
 *   location: "eastus",
 *   sku: "Standard",
 * });
 * const replica = yield* Azure.AppConfiguration.Replica("west", {
 *   resourceGroup: group.resourceGroupName,
 *   configurationStore: store.configurationStoreName,
 *   location: "westus2",
 * });
 * ```
 *
 * @resource
 */
export const Replica = Resource<Replica>("Azure.AppConfiguration.Replica");

/**
 * Alphanumeric replica name; Azure caps it at 50 characters and the store
 * and replica names together at 60.
 */
const createReplicaName = Effect.fn(function* (
  id: string,
  configurationStore: string,
) {
  const maxLength = Math.max(8, Math.min(50, 60 - configurationStore.length));
  const name = yield* createPhysicalName({
    id,
    maxLength,
    suffixLength: Math.min(16, maxLength),
    lowercase: true,
    delimiter: "",
  });
  return name.replace(/[^a-z0-9]/g, "");
});

const getReplica = (
  subscriptionId: string,
  resourceGroupName: string,
  configStoreName: string,
  replicaName: string,
) =>
  orUndefinedIfNotFound(
    appconfiguration.GetReplicas({
      subscriptionId,
      resourceGroupName,
      configStoreName,
      replicaName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  configurationStore: string,
  name: string,
  replica: appconfiguration.Replica,
): Replica["Attributes"] => ({
  replicaName: name,
  configurationStore,
  resourceGroup,
  location: replica.location ?? "",
  replicaId: replica.id ?? "",
  endpoint: replica.properties?.endpoint ?? "",
});

const normLocation = (value: string | undefined) =>
  value?.toLowerCase().replace(/\s/g, "");

export const ReplicaProvider = () =>
  Provider.succeed(Replica, {
    stables: [
      "replicaName",
      "configurationStore",
      "resourceGroup",
      "location",
      "replicaId",
      "endpoint",
    ],

    // Replicas live inside a store; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.configurationStore !== output.configurationStore ||
        normLocation(news.location) !== normLocation(output.location) ||
        (news.name !== undefined && news.name !== output.replicaName)
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
        output?.replicaName ??
        olds?.name ??
        (yield* createReplicaName(id, store));
      const observed = yield* getReplica(
        subscriptionId,
        resourceGroup,
        store,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, store, name, observed);
      const parent = yield* getConfigurationStore(
        subscriptionId,
        resourceGroup,
        store,
      );
      const { stack, stage } = yield* stackAndStage;
      const tags = tagRecord(parent?.tags);
      return tags["alchemy::stack"] === stack &&
        tags["alchemy::stage"] === stage
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.AppConfiguration");
      const { resourceGroup, configurationStore, location } = news;
      const name =
        news.name ??
        output?.replicaName ??
        (yield* createReplicaName(id, configurationStore));
      const get = getReplica(
        subscriptionId,
        resourceGroup,
        configurationStore,
        name,
      );

      // Observe; ensure (existence-only — a replica has no mutable settings).
      const observed = yield* get;
      if (observed === undefined) {
        yield* appconfiguration.CreateReplicas({
          subscriptionId,
          resourceGroupName: resourceGroup,
          configStoreName: configurationStore,
          replicaName: name,
          location,
        });
      }
      const ready = yield* waitForProvisioned(
        `app configuration replica ${name}`,
        get,
        (replica) => replica.properties?.provisioningState,
        { interval: "5 seconds", times: 60 },
      );
      return toAttrs(resourceGroup, configurationStore, name, ready);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        appconfiguration.DeleteReplicas({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          configStoreName: output.configurationStore,
          replicaName: output.replicaName,
        }),
      );
      yield* waitUntilGone(
        `app configuration replica ${output.replicaName}`,
        getReplica(
          subscriptionId,
          output.resourceGroup,
          output.configurationStore,
          output.replicaName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),
  });
