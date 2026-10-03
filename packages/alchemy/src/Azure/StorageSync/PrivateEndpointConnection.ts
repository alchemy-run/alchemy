import * as storagesync from "@distilled.cloud/azure/storagesync";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  requireSinglePage,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { isServiceOwnedByStack, sameName } from "./internal.ts";

export interface PrivateEndpointConnectionProps {
  /**
   * Resource group of the Storage Sync Service. Changing it replaces the
   * connection.
   */
  resourceGroup: string;
  /**
   * Storage Sync Service the private endpoint connects to. Changing it
   * replaces the connection.
   */
  storageSyncService: string;
  /**
   * ARM ID of the private endpoint whose connection request is managed.
   * Changing it replaces the connection.
   */
  privateEndpointId: string;
  /**
   * Decision on the connection request. A rejected connection cannot be
   * approved again; the private endpoint must be recreated.
   * @default "Approved"
   */
  status?: "Approved" | "Rejected";
  /**
   * Reason for the decision, shown to the private endpoint's owner. Azure
   * records it only when the status changes; changing just the description
   * of an existing decision has no effect.
   * @default unmanaged
   */
  description?: string;
}

export interface PrivateEndpointConnection extends Resource<
  "Azure.StorageSync.PrivateEndpointConnection",
  PrivateEndpointConnectionProps,
  {
    /** Name of the connection (assigned by Azure). */
    privateEndpointConnectionName: string;
    /** ARM resource ID of the connection. */
    privateEndpointConnectionId: string;
    /** Storage Sync Service the private endpoint connects to. */
    storageSyncServiceName: string;
    /** Resource group of the Storage Sync Service. */
    resourceGroup: string;
    /** ARM ID of the private endpoint. */
    privateEndpointId: string;
    /** Observed status: `Pending`, `Approved`, or `Rejected`. */
    status: string | undefined;
    /** Observed reason for the decision. */
    description: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Approval of a private endpoint's connection to an Azure File Sync
 * Storage Sync Service.
 *
 * Connections are not created directly: a private endpoint that targets
 * the service (group `afs`) with a *manual* connection — for example from
 * another team's subscription — leaves a `Pending` request on the service.
 * This resource approves or rejects that request. Destroying it removes the
 * connection, which disconnects the private endpoint.
 *
 * @see https://learn.microsoft.com/azure/storage/file-sync/file-sync-networking-endpoints
 *
 * ### Approving Connections
 * **Example:** Approve a manual private endpoint request
 * ```typescript
 * const endpoint = yield* Azure.Network.PrivateEndpoint("sync-afs", {
 *   resourceGroup: group.resourceGroupName,
 *   subnetId: subnet.subnetId,
 *   manualPrivateLinkServiceConnections: [
 *     { privateLinkServiceId: sync.storageSyncServiceId, groupIds: ["afs"] },
 *   ],
 * });
 * yield* Azure.StorageSync.PrivateEndpointConnection("sync-afs-approval", {
 *   resourceGroup: group.resourceGroupName,
 *   storageSyncService: sync.storageSyncServiceName,
 *   privateEndpointId: endpoint.privateEndpointId,
 *   description: "Approved for the branch-office VNet",
 * });
 * ```
 *
 * **Example:** Reject a request
 * ```typescript
 * yield* Azure.StorageSync.PrivateEndpointConnection("sync-afs-approval", {
 *   resourceGroup: group.resourceGroupName,
 *   storageSyncService: sync.storageSyncServiceName,
 *   privateEndpointId: endpoint.privateEndpointId,
 *   status: "Rejected",
 *   description: "Use the shared endpoint instead",
 * });
 * ```
 *
 * @resource
 */
export const PrivateEndpointConnection = Resource<PrivateEndpointConnection>(
  "Azure.StorageSync.PrivateEndpointConnection",
);

export class PrivateEndpointConnectionRequestMissing extends Data.TaggedError(
  "Azure.StorageSync.PrivateEndpointConnectionRequestMissing",
)<{ readonly message: string }> {}

type Observed = storagesync.GetPrivateEndpointConnectionResponse;

const sameId = (a: string | undefined, b: string) =>
  (a ?? "").toLowerCase() === b.toLowerCase();

const getConnection = (
  subscriptionId: string,
  resourceGroupName: string,
  storageSyncServiceName: string,
  privateEndpointConnectionName: string,
) =>
  orUndefinedIfNotFound(
    storagesync.GetPrivateEndpointConnection({
      subscriptionId,
      resourceGroupName,
      storageSyncServiceName,
      privateEndpointConnectionName,
    }),
  );

/** The service's connection for the given private endpoint. */
const findConnection = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  storageSyncServiceName: string,
  privateEndpointId: string,
) {
  const page = yield* orUndefinedIfNotFound(
    storagesync
      .ListPrivateEndpointConnectionByStorageSyncService({
        subscriptionId,
        resourceGroupName,
        storageSyncServiceName,
      })
      .pipe(
        Effect.flatMap((page) =>
          requireSinglePage(
            "ListPrivateEndpointConnectionByStorageSyncService",
            page,
          ),
        ),
      ),
  );
  return (page?.value ?? []).find((connection) =>
    sameId(connection.properties?.privateEndpoint?.id, privateEndpointId),
  );
});

const toAttrs = (
  resourceGroup: string,
  storageSyncServiceName: string,
  privateEndpointId: string,
  connection: Observed,
): PrivateEndpointConnection["Attributes"] => ({
  privateEndpointConnectionName: connection.name ?? "",
  privateEndpointConnectionId: connection.id ?? "",
  storageSyncServiceName,
  resourceGroup,
  privateEndpointId,
  status: connection.properties?.privateLinkServiceConnectionState.status,
  description:
    connection.properties?.privateLinkServiceConnectionState.description,
});

export const PrivateEndpointConnectionProvider = () =>
  Provider.succeed(PrivateEndpointConnection, {
    stables: [
      "privateEndpointConnectionName",
      "privateEndpointConnectionId",
      "storageSyncServiceName",
      "resourceGroup",
      "privateEndpointId",
    ],

    // Connections disappear with their Storage Sync Service or endpoint.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.storageSyncService, output.storageSyncServiceName) ||
        !sameId(news.privateEndpointId, output.privateEndpointId)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const storageSyncService =
        output?.storageSyncServiceName ?? olds?.storageSyncService;
      const privateEndpointId =
        output?.privateEndpointId ?? olds?.privateEndpointId;
      if (
        resourceGroup === undefined ||
        storageSyncService === undefined ||
        privateEndpointId === undefined
      ) {
        return undefined;
      }
      const observed = yield* findConnection(
        subscriptionId,
        resourceGroup,
        storageSyncService,
        privateEndpointId,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        storageSyncService,
        privateEndpointId,
        observed,
      );
      return (yield* isServiceOwnedByStack(
        subscriptionId,
        resourceGroup,
        storageSyncService,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.StorageSync");
      const { resourceGroup, storageSyncService, privateEndpointId } = news;
      const status = news.status ?? "Approved";

      // Observe. The request appears on the service shortly after the
      // private endpoint is created; it cannot be created from this side.
      const observed = yield* findConnection(
        subscriptionId,
        resourceGroup,
        storageSyncService,
        privateEndpointId,
      ).pipe(
        Effect.flatMap((found) =>
          found === undefined
            ? Effect.fail(
                new PrivateEndpointConnectionRequestMissing({
                  message: `no connection from private endpoint ${privateEndpointId} on storage sync service ${storageSyncService}`,
                }),
              )
            : Effect.succeed(found),
        ),
        Effect.retry({
          while: (e) =>
            e._tag ===
            "Azure.StorageSync.PrivateEndpointConnectionRequestMissing",
          schedule: Schedule.spaced("5 seconds"),
          times: 12,
        }),
      );
      const name = observed.name ?? "";
      const get = getConnection(
        subscriptionId,
        resourceGroup,
        storageSyncService,
        name,
      );

      // Sync the decision. Azure only records the description together
      // with a status change, so a description-only change is not sent.
      const state = observed.properties?.privateLinkServiceConnectionState;
      if (state?.status !== status) {
        yield* storagesync.CreatePrivateEndpointConnection({
          subscriptionId,
          resourceGroupName: resourceGroup,
          storageSyncServiceName: storageSyncService,
          privateEndpointConnectionName: name,
          properties: {
            privateLinkServiceConnectionState: {
              status,
              description: news.description ?? state?.description,
            },
          },
        });
      }
      const fresh = yield* waitForProvisioned(
        `private endpoint connection ${name}`,
        get,
        (connection) =>
          connection.properties?.privateLinkServiceConnectionState.status ===
          status
            ? connection.properties.provisioningState
            : "Updating",
        { interval: "3 seconds", times: 40 },
      );
      return toAttrs(
        resourceGroup,
        storageSyncService,
        privateEndpointId,
        fresh,
      );
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        storagesync.DeletePrivateEndpointConnection({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          storageSyncServiceName: output.storageSyncServiceName,
          privateEndpointConnectionName: output.privateEndpointConnectionName,
        }),
      );
      yield* waitUntilGone(
        `private endpoint connection ${output.privateEndpointConnectionName}`,
        getConnection(
          subscriptionId,
          output.resourceGroup,
          output.storageSyncServiceName,
          output.privateEndpointConnectionName,
        ),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.StorageSync.StorageSyncService",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
