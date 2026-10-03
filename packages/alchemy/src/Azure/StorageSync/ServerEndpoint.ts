import * as storagesync from "@distilled.cloud/azure/storagesync";
import * as Data from "effect/Data";
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
  createChildName,
  isServiceOwnedByStack,
  sameName,
} from "./internal.ts";

export type FeatureStatus = "on" | "off";
export type InitialDownloadPolicy =
  | "NamespaceOnly"
  | "NamespaceThenModifiedFiles"
  | "AvoidTieredFiles";
export type InitialUploadPolicy = "ServerAuthoritative" | "Merge";
export type LocalCacheMode =
  | "DownloadNewAndModifiedFiles"
  | "UpdateLocallyCachedFiles";

export interface ServerEndpointProps {
  /**
   * Resource group of the Storage Sync Service. Changing it replaces the
   * server endpoint.
   */
  resourceGroup: string;
  /**
   * Name of the Storage Sync Service. Changing it replaces the server
   * endpoint.
   */
  storageSyncService: string;
  /** Name of the parent sync group. Changing it replaces the server endpoint. */
  syncGroup: string;
  /**
   * Name of the server endpoint. If omitted, a unique name is generated
   * from the app, stage, and logical ID. Changing it replaces the endpoint.
   */
  name?: string;
  /**
   * ARM ID of the registered server
   * (`.../storageSyncServices/{service}/registeredServers/{serverId}`). The
   * server registers itself with the Azure File Sync agent. Changing it
   * replaces the endpoint.
   */
  serverResourceId: string;
  /**
   * Local NTFS path on the server to sync, e.g. `D:\\Shares\\Docs`.
   * Changing it replaces the endpoint.
   */
  serverLocalPath: string;
  /**
   * How the server downloads existing cloud content when the endpoint is
   * created. Changing it replaces the endpoint.
   * @default Azure's default (`NamespaceThenModifiedFiles`)
   */
  initialDownloadPolicy?: InitialDownloadPolicy;
  /**
   * How the initial upload merges server content with the share. Changing
   * it replaces the endpoint.
   * @default Azure's default (`Merge`)
   */
  initialUploadPolicy?: InitialUploadPolicy;
  /**
   * Display name of the endpoint. Azure cannot rename an existing server
   * endpoint, so changing it replaces the endpoint.
   * @default chosen by Azure
   */
  friendlyName?: string;
  /**
   * Cloud tiering: keep only hot files locally and tier the rest to the
   * share.
   * @default Azure's default (`off`)
   */
  cloudTiering?: FeatureStatus;
  /**
   * Free space (percent of the volume) cloud tiering maintains.
   * @default Azure's default (20)
   */
  volumeFreeSpacePercent?: number;
  /** Tier files not accessed for this many days (cloud tiering only). */
  tierFilesOlderThanDays?: number;
  /**
   * Offline data transfer (Azure Data Box seeding).
   * @default Azure's default (`off`)
   */
  offlineDataTransfer?: FeatureStatus;
  /** File share used for offline data transfer. */
  offlineDataTransferShareName?: string;
  /** How the local cache follows changes made elsewhere. */
  localCacheMode?: LocalCacheMode;
}

export interface ServerEndpoint extends Resource<
  "Azure.StorageSync.ServerEndpoint",
  ServerEndpointProps,
  {
    /** Name of the server endpoint. */
    serverEndpointName: string;
    /** ARM resource ID of the server endpoint. */
    serverEndpointId: string;
    /** Name of the parent sync group. */
    syncGroupName: string;
    /** Name of the Storage Sync Service. */
    storageSyncServiceName: string;
    /** Resource group of the Storage Sync Service. */
    resourceGroup: string;
    /** ARM ID of the registered server. */
    serverResourceId: string | undefined;
    /** Synced local path on the server. */
    serverLocalPath: string | undefined;
    /** Name of the registered server. */
    serverName: string | undefined;
    /** Display name of the endpoint. */
    friendlyName: string | undefined;
    /** Observed cloud tiering setting. */
    cloudTiering: string | undefined;
    /** Observed free-space policy. */
    volumeFreeSpacePercent: number | undefined;
    /** Observed date policy. */
    tierFilesOlderThanDays: number | undefined;
    /** Observed offline data transfer setting. */
    offlineDataTransfer: string | undefined;
    /** Observed offline data transfer share. */
    offlineDataTransferShareName: string | undefined;
    /** Observed local cache mode. */
    localCacheMode: string | undefined;
    /** Observed initial download policy. */
    initialDownloadPolicy: string | undefined;
    /** Observed initial upload policy. */
    initialUploadPolicy: string | undefined;
    /** Combined health of the endpoint's sync sessions. */
    syncHealth: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Azure File Sync server endpoint — a path on a registered Windows
 * server that syncs with the sync group's cloud endpoint, optionally with
 * cloud tiering.
 *
 * The server must already run the Azure File Sync agent and be registered
 * with the Storage Sync Service; registration happens on the server, not
 * through ARM.
 *
 * @see https://learn.microsoft.com/azure/storage/file-sync/file-sync-server-endpoint-create
 *
 * ### Creating a Server Endpoint
 * **Example:** Sync a server folder
 * ```typescript
 * yield* Azure.StorageSync.ServerEndpoint("docs-server", {
 *   resourceGroup: group.resourceGroupName,
 *   storageSyncService: sync.storageSyncServiceName,
 *   syncGroup: syncGroup.syncGroupName,
 *   serverResourceId: Output.interpolate`${sync.storageSyncServiceId}/registeredServers/${serverId}`,
 *   serverLocalPath: "D:\\Shares\\Docs",
 * });
 * ```
 *
 * ### Cloud Tiering
 * **Example:** Keep 30% of the volume free
 * ```typescript
 * yield* Azure.StorageSync.ServerEndpoint("docs-server", {
 *   resourceGroup: group.resourceGroupName,
 *   storageSyncService: sync.storageSyncServiceName,
 *   syncGroup: syncGroup.syncGroupName,
 *   serverResourceId: registeredServerId,
 *   serverLocalPath: "D:\\Shares\\Docs",
 *   cloudTiering: "on",
 *   volumeFreeSpacePercent: 30,
 *   tierFilesOlderThanDays: 60,
 * });
 * ```
 *
 * @resource
 */
export const ServerEndpoint = Resource<ServerEndpoint>(
  "Azure.StorageSync.ServerEndpoint",
);

export class RegisteredServerNotFound extends Data.TaggedError(
  "Azure.StorageSync.RegisteredServerNotFound",
)<{ readonly serverResourceId: string; readonly message: string }> {}

type Observed = storagesync.GetServerEndpointResponse;

/**
 * Fail fast when the server is not registered with the service: ARM accepts
 * the PUT and the endpoint then silently never appears.
 */
const requireRegisteredServer = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  storageSyncServiceName: string,
  serverResourceId: string,
) {
  const serverId = serverResourceId.match(
    /\/registeredServers\/([^/]+)$/i,
  )?.[1];
  const server =
    serverId === undefined
      ? undefined
      : yield* orUndefinedIfNotFound(
          storagesync.GetRegisteredServer({
            subscriptionId,
            resourceGroupName,
            storageSyncServiceName,
            serverId,
          }),
        );
  if (server === undefined) {
    return yield* new RegisteredServerNotFound({
      serverResourceId,
      message: `server ${serverResourceId} is not registered with storage sync service ${storageSyncServiceName}; register it with the Azure File Sync agent first`,
    });
  }
});

const createServerEndpointName = (id: string) => createChildName(id, 60);

const getServerEndpoint = (
  subscriptionId: string,
  resourceGroupName: string,
  storageSyncServiceName: string,
  syncGroupName: string,
  serverEndpointName: string,
) =>
  orUndefinedIfNotFound(
    storagesync.GetServerEndpoint({
      subscriptionId,
      resourceGroupName,
      storageSyncServiceName,
      syncGroupName,
      serverEndpointName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  storageSyncServiceName: string,
  syncGroupName: string,
  name: string,
  observed: Observed,
): ServerEndpoint["Attributes"] => {
  const props = observed.properties;
  return {
    serverEndpointName: name,
    serverEndpointId: observed.id ?? "",
    syncGroupName,
    storageSyncServiceName,
    resourceGroup,
    serverResourceId: props?.serverResourceId,
    serverLocalPath: props?.serverLocalPath,
    serverName: props?.serverName,
    friendlyName: props?.friendlyName,
    cloudTiering: props?.cloudTiering,
    volumeFreeSpacePercent: props?.volumeFreeSpacePercent,
    tierFilesOlderThanDays: props?.tierFilesOlderThanDays,
    offlineDataTransfer: props?.offlineDataTransfer,
    offlineDataTransferShareName: props?.offlineDataTransferShareName,
    localCacheMode: props?.localCacheMode,
    initialDownloadPolicy: props?.initialDownloadPolicy,
    initialUploadPolicy: props?.initialUploadPolicy,
    syncHealth: props?.syncStatus?.combinedHealth,
  };
};

/** PATCH body holding only the mutable settings that differ from Azure. */
const updateDelta = (
  news: ServerEndpointProps,
  observed: storagesync.ServerEndpointProperties | undefined,
): storagesync.ServerEndpointUpdateProperties => {
  const delta: storagesync.ServerEndpointUpdateProperties = {};
  if (
    news.cloudTiering !== undefined &&
    observed?.cloudTiering !== news.cloudTiering
  ) {
    delta.cloudTiering = news.cloudTiering;
  }
  if (
    news.volumeFreeSpacePercent !== undefined &&
    observed?.volumeFreeSpacePercent !== news.volumeFreeSpacePercent
  ) {
    delta.volumeFreeSpacePercent = news.volumeFreeSpacePercent;
  }
  if (
    news.tierFilesOlderThanDays !== undefined &&
    observed?.tierFilesOlderThanDays !== news.tierFilesOlderThanDays
  ) {
    delta.tierFilesOlderThanDays = news.tierFilesOlderThanDays;
  }
  if (
    news.offlineDataTransfer !== undefined &&
    observed?.offlineDataTransfer !== news.offlineDataTransfer
  ) {
    delta.offlineDataTransfer = news.offlineDataTransfer;
  }
  if (
    news.offlineDataTransferShareName !== undefined &&
    observed?.offlineDataTransferShareName !== news.offlineDataTransferShareName
  ) {
    delta.offlineDataTransferShareName = news.offlineDataTransferShareName;
  }
  if (
    news.localCacheMode !== undefined &&
    observed?.localCacheMode !== news.localCacheMode
  ) {
    delta.localCacheMode = news.localCacheMode;
  }
  return delta;
};

export const ServerEndpointProvider = () =>
  Provider.succeed(ServerEndpoint, {
    stables: [
      "serverEndpointName",
      "serverEndpointId",
      "syncGroupName",
      "storageSyncServiceName",
      "resourceGroup",
      "serverResourceId",
      "serverLocalPath",
    ],

    // Server endpoints disappear with their sync group.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.storageSyncService, output.storageSyncServiceName) ||
        !sameName(news.syncGroup, output.syncGroupName) ||
        (news.name !== undefined &&
          !sameName(news.name, output.serverEndpointName)) ||
        !sameName(news.serverResourceId, output.serverResourceId) ||
        !sameName(news.serverLocalPath, output.serverLocalPath) ||
        (news.initialDownloadPolicy !== undefined &&
          news.initialDownloadPolicy !== output.initialDownloadPolicy) ||
        (news.initialUploadPolicy !== undefined &&
          news.initialUploadPolicy !== output.initialUploadPolicy) ||
        (news.friendlyName !== undefined &&
          news.friendlyName !== output.friendlyName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const service =
        output?.storageSyncServiceName ?? olds?.storageSyncService;
      const syncGroup = output?.syncGroupName ?? olds?.syncGroup;
      if (
        resourceGroup === undefined ||
        service === undefined ||
        syncGroup === undefined
      ) {
        return undefined;
      }
      const name =
        output?.serverEndpointName ??
        olds?.name ??
        (yield* createServerEndpointName(id));
      const observed = yield* getServerEndpoint(
        subscriptionId,
        resourceGroup,
        service,
        syncGroup,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, service, syncGroup, name, observed);
      return (yield* isServiceOwnedByStack(
        subscriptionId,
        resourceGroup,
        service,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.StorageSync");
      const { resourceGroup, storageSyncService, syncGroup } = news;
      const name =
        news.name ??
        output?.serverEndpointName ??
        (yield* createServerEndpointName(id));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        storageSyncServiceName: storageSyncService,
        syncGroupName: syncGroup,
        serverEndpointName: name,
      };
      const label = `server endpoint ${name}`;
      const get = getServerEndpoint(
        subscriptionId,
        resourceGroup,
        storageSyncService,
        syncGroup,
        name,
      );
      const budget = { interval: "5 seconds", times: 60 } as const;

      // Observe.
      let observed = yield* get;

      // Ensure. The PUT is a long-running operation run by the agent.
      if (observed === undefined) {
        yield* requireRegisteredServer(
          subscriptionId,
          resourceGroup,
          storageSyncService,
          news.serverResourceId,
        );
        yield* storagesync.CreateServerEndpoint({
          ...where,
          properties: {
            serverResourceId: news.serverResourceId,
            serverLocalPath: news.serverLocalPath,
            initialDownloadPolicy: news.initialDownloadPolicy,
            initialUploadPolicy: news.initialUploadPolicy,
            friendlyName: news.friendlyName,
            cloudTiering: news.cloudTiering,
            volumeFreeSpacePercent: news.volumeFreeSpacePercent,
            tierFilesOlderThanDays: news.tierFilesOlderThanDays,
            offlineDataTransfer: news.offlineDataTransfer,
            offlineDataTransferShareName: news.offlineDataTransferShareName,
            localCacheMode: news.localCacheMode,
          },
        });
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        (endpoint) => endpoint.properties?.provisioningState,
        budget,
      );

      // Sync mutable settings against the observed state; PATCH the delta.
      const delta = updateDelta(news, observed.properties);
      if (Object.keys(delta).length > 0) {
        yield* storagesync.UpdateServerEndpoint({
          ...where,
          properties: delta,
        });
        observed = yield* waitForProvisioned(
          label,
          get,
          (endpoint) =>
            Object.keys(updateDelta(news, endpoint.properties)).length === 0
              ? endpoint.properties?.provisioningState
              : "Updating",
          budget,
        );
      }

      return toAttrs(
        resourceGroup,
        storageSyncService,
        syncGroup,
        name,
        observed,
      );
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        storagesync.DeleteServerEndpoint({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          storageSyncServiceName: output.storageSyncServiceName,
          syncGroupName: output.syncGroupName,
          serverEndpointName: output.serverEndpointName,
        }),
      );
      yield* waitUntilGone(
        `server endpoint ${output.serverEndpointName}`,
        getServerEndpoint(
          subscriptionId,
          output.resourceGroup,
          output.storageSyncServiceName,
          output.syncGroupName,
          output.serverEndpointName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.StorageSync.SyncGroup",
        "Azure.StorageSync.StorageSyncService",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
