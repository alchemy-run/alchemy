import * as containerregistry from "@distilled.cloud/azure/containerregistry";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createRegistryName,
  matchesObserved,
  registryOwnedByStage,
  sameName,
  sameSet,
} from "./Common.ts";

export type ConnectedRegistryMode =
  | "ReadWrite"
  | "ReadOnly"
  | "Registry"
  | "Mirror";

export interface ConnectedRegistryLogging {
  /** Log verbosity. @default Azure's default (`Information`) */
  logLevel?: "Debug" | "Information" | "Warning" | "Error" | "None";
  /** Whether audit logs are enabled. @default Azure's default (`Disabled`) */
  auditLogStatus?: "Enabled" | "Disabled";
}

export interface ConnectedRegistryGarbageCollection {
  /** Whether garbage collection runs on the connected registry. */
  enabled?: boolean;
  /** Cron schedule of garbage collection. */
  schedule?: string;
}

export interface ConnectedRegistryProps {
  /** Resource group of the registry. Changing it replaces the connected registry. */
  resourceGroup: string;
  /**
   * Premium cloud registry (with `dataEndpointEnabled: true`) the connected
   * registry syncs with. Changing it replaces the connected registry.
   */
  registry: string;
  /**
   * Connected registry name: 5-50 letters and digits. If omitted, a unique
   * name is generated from the app, stage, and logical ID. Changing it
   * replaces the connected registry.
   */
  name?: string;
  /**
   * Access mode of the on-premises registry. Changing it replaces the
   * connected registry.
   */
  mode: ConnectedRegistryMode;
  /**
   * ARM resource ID of the `Token` the connected registry uses to sync with
   * its parent. Changing it replaces the connected registry.
   */
  syncTokenId: string;
  /**
   * ARM resource ID of a parent connected registry (for nested
   * deployments). Omit to sync with the cloud registry. Changing it
   * replaces the connected registry.
   */
  parentId?: string;
  /**
   * How long a sync message stays available (ISO 8601 duration).
   * @default "P1D"
   */
  messageTtl?: string;
  /**
   * Cron schedule of sync windows. Omit to sync continuously.
   */
  schedule?: string;
  /** Length of each sync window (ISO 8601 duration); requires `schedule`. */
  syncWindow?: string;
  /** ARM resource IDs of `Token`s that clients use against the connected registry. */
  clientTokenIds?: string[];
  /** Logging settings of the connected registry. */
  logging?: ConnectedRegistryLogging;
  /**
   * Notification subscriptions, e.g. `hello-world:*:push`
   * (`{repository}:{tag}:{action}`).
   */
  notificationsList?: string[];
  /** Garbage collection settings. */
  garbageCollection?: ConnectedRegistryGarbageCollection;
}

export interface ConnectedRegistry extends Resource<
  "Azure.ContainerRegistry.ConnectedRegistry",
  ConnectedRegistryProps,
  {
    /** Name of the connected registry. */
    connectedRegistryName: string;
    /** ARM resource ID of the connected registry. */
    connectedRegistryId: string;
    /** Cloud registry the connected registry belongs to. */
    registry: string;
    /** Resource group of the registry. */
    resourceGroup: string;
    /** Access mode. */
    mode: string;
    /** Sync token resource ID. */
    syncTokenId: string;
    /** Parent connected registry, if any. */
    parentId: string | undefined;
    /** Connection state (`Online`, `Offline`, `Syncing`, `Unhealthy`). */
    connectionState: string | undefined;
    /** Activation status (`Active` once an on-premises instance connected). */
    activationStatus: string | undefined;
    /** ACR runtime version reported by the on-premises instance. */
    version: string | undefined;
    /** Last activity time (ISO 8601). */
    lastActivityTime: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A connected registry — the cloud-side definition of an on-premises or
 * edge (e.g. IoT Edge / Arc) registry that syncs with a Premium registry.
 *
 * The ARM resource can exist before any on-premises instance is deployed
 * (it stays `Offline`). Alchemy deactivates an active connected registry
 * before deleting it. Connected registries have no tags; Alchemy treats one
 * as owned when its registry carries this stack's ownership tags.
 *
 * @see https://learn.microsoft.com/azure/container-registry/intro-connected-registry
 *
 * ### Defining a Connected Registry
 * **Example:** Read-only mirror synced with a sync token
 * ```typescript
 * const registry = yield* Azure.ContainerRegistry.Registry("images", {
 *   resourceGroup: group.resourceGroupName,
 *   sku: "Premium",
 *   dataEndpointEnabled: true,
 * });
 * const syncScope = yield* Azure.ContainerRegistry.ScopeMap("edge-sync", {
 *   resourceGroup: group.resourceGroupName,
 *   registry: registry.registryName,
 *   actions: [
 *     "repositories/hello-world/content/read",
 *     "repositories/hello-world/metadata/read",
 *     "gateway/edgegateway/config/read",
 *     "gateway/edgegateway/config/write",
 *     "gateway/edgegateway/message/read",
 *     "gateway/edgegateway/message/write",
 *   ],
 * });
 * const syncToken = yield* Azure.ContainerRegistry.Token("edge-sync", {
 *   resourceGroup: group.resourceGroupName,
 *   registry: registry.registryName,
 *   scopeMapId: syncScope.scopeMapId,
 * });
 * const edge = yield* Azure.ContainerRegistry.ConnectedRegistry("edge", {
 *   resourceGroup: group.resourceGroupName,
 *   registry: registry.registryName,
 *   name: "edgegateway",
 *   mode: "ReadOnly",
 *   syncTokenId: syncToken.tokenId,
 * });
 * ```
 *
 * @resource
 */
export const ConnectedRegistry = Resource<ConnectedRegistry>(
  "Azure.ContainerRegistry.ConnectedRegistry",
);

const getConnectedRegistry = (
  subscriptionId: string,
  resourceGroupName: string,
  registryName: string,
  connectedRegistryName: string,
) =>
  orUndefinedIfNotFound(
    containerregistry.GetConnectedRegistry({
      subscriptionId,
      resourceGroupName,
      registryName,
      connectedRegistryName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  registry: string,
  name: string,
  connected: containerregistry.GetConnectedRegistryResponse,
): ConnectedRegistry["Attributes"] => {
  const props = connected.properties;
  return {
    connectedRegistryName: name,
    connectedRegistryId: connected.id ?? "",
    registry,
    resourceGroup,
    mode: props?.mode ?? "",
    syncTokenId: props?.parent?.syncProperties?.tokenId ?? "",
    parentId: props?.parent?.id || undefined,
    connectionState: props?.connectionState,
    activationStatus: props?.activation?.status,
    version: props?.version,
    lastActivityTime: props?.lastActivityTime,
  };
};

export const ConnectedRegistryProvider = () =>
  Provider.succeed(ConnectedRegistry, {
    stables: [
      "connectedRegistryName",
      "connectedRegistryId",
      "registry",
      "resourceGroup",
      "mode",
      "syncTokenId",
      "parentId",
    ],

    // Connected registries live inside a registry; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.registry, output.registry) ||
        (news.name !== undefined &&
          !sameName(news.name, output.connectedRegistryName)) ||
        news.mode.toLowerCase() !== output.mode.toLowerCase() ||
        !sameName(news.syncTokenId, output.syncTokenId) ||
        !sameName(news.parentId, output.parentId)
      ) {
        // A kept explicit name must be freed before it can be reused.
        return {
          action: "replace",
          deleteFirst:
            news.name !== undefined &&
            sameName(news.name, output.connectedRegistryName),
        } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const registry = output?.registry ?? olds?.registry;
      if (resourceGroup === undefined || registry === undefined) {
        return undefined;
      }
      const name =
        output?.connectedRegistryName ??
        olds?.name ??
        (yield* createRegistryName(id));
      const observed = yield* getConnectedRegistry(
        subscriptionId,
        resourceGroup,
        registry,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, registry, name, observed);
      return (yield* registryOwnedByStage(
        subscriptionId,
        resourceGroup,
        registry,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.ContainerRegistry");
      const { resourceGroup, registry } = news;
      const name =
        news.name ??
        output?.connectedRegistryName ??
        (yield* createRegistryName(id));
      const messageTtl = news.messageTtl ?? "P1D";
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        registryName: registry,
        connectedRegistryName: name,
      };
      const get = getConnectedRegistry(
        subscriptionId,
        resourceGroup,
        registry,
        name,
      );
      const waitReady = waitForProvisioned(
        `connected registry ${name}`,
        get,
        (connected) => connected.properties?.provisioningState,
        { interval: "3 seconds", times: 40 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* containerregistry.CreateConnectedRegistry({
          ...where,
          properties: {
            mode: news.mode,
            parent: {
              id: news.parentId,
              syncProperties: {
                tokenId: news.syncTokenId,
                messageTtl,
                schedule: news.schedule,
                syncWindow: news.syncWindow,
              },
            },
            clientTokenIds: news.clientTokenIds,
            logging: news.logging,
            notificationsList: news.notificationsList,
            garbageCollection: news.garbageCollection,
          },
        });
      }
      observed = yield* waitReady;

      // Sync mutable settings against the observed connected registry.
      const props = observed.properties;
      const sync = props?.parent?.syncProperties;
      const changed: containerregistry.ConnectedRegistryUpdateProperties = {};
      const syncDesired = {
        messageTtl,
        schedule: news.schedule,
        syncWindow: news.syncWindow,
      };
      if (!matchesObserved(syncDesired, sync)) {
        changed.syncProperties = syncDesired;
      }
      if (
        news.clientTokenIds !== undefined &&
        !sameSet(
          (props?.clientTokenIds ?? []).map((t) => t.toLowerCase()),
          news.clientTokenIds.map((t) => t.toLowerCase()),
        )
      ) {
        changed.clientTokenIds = news.clientTokenIds;
      }
      if (!matchesObserved(news.logging, props?.logging)) {
        changed.logging = news.logging;
      }
      if (
        news.notificationsList !== undefined &&
        !sameSet(props?.notificationsList, news.notificationsList)
      ) {
        changed.notificationsList = news.notificationsList;
      }
      if (!matchesObserved(news.garbageCollection, props?.garbageCollection)) {
        changed.garbageCollection = news.garbageCollection;
      }
      if (Object.keys(changed).length > 0) {
        yield* containerregistry.UpdateConnectedRegistry({
          ...where,
          properties: changed,
        });
        observed = yield* waitReady;
      }

      return toAttrs(resourceGroup, registry, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        registryName: output.registry,
        connectedRegistryName: output.connectedRegistryName,
      };
      const get = getConnectedRegistry(
        subscriptionId,
        output.resourceGroup,
        output.registry,
        output.connectedRegistryName,
      );
      // An activated connected registry must be deactivated first.
      const observed = yield* get;
      if (observed?.properties?.activation?.status === "Active") {
        yield* ignoreNotFound(
          containerregistry.DeactivateConnectedRegistry(where),
        );
      }
      yield* ignoreNotFound(containerregistry.DeleteConnectedRegistry(where));
      yield* waitUntilGone(
        `connected registry ${output.connectedRegistryName}`,
        get,
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.ContainerRegistry.Registry",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
