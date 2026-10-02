import * as storage from "@distilled.cloud/azure/storage";
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
import { isAccountOwnedByStack } from "./StorageOwnership.ts";

export interface PrivateEndpointConnectionProps {
  /**
   * Resource group of the storage account. Changing it replaces the
   * connection.
   */
  resourceGroup: string;
  /**
   * Storage account the private endpoint connects to. Changing it replaces
   * the connection.
   */
  storageAccount: string;
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
  "Azure.Storage.PrivateEndpointConnection",
  PrivateEndpointConnectionProps,
  {
    /** Name of the connection (assigned by Azure). */
    privateEndpointConnectionName: string;
    /** ARM resource ID of the connection. */
    privateEndpointConnectionId: string;
    /** Storage account the private endpoint connects to. */
    storageAccount: string;
    /** Resource group of the storage account. */
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
 * Approval of a private endpoint's connection to a Storage account.
 *
 * Connections are not created directly: a private endpoint that targets
 * the account with a *manual* connection (for example from another team's
 * subscription) leaves a `Pending` request on the account. This resource
 * approves or rejects that request. Destroying it removes the connection,
 * which disconnects the private endpoint.
 *
 * @see https://learn.microsoft.com/azure/private-link/manage-private-endpoint
 *
 * ### Approving Connections
 * **Example:** Approve a manual private endpoint request
 * ```typescript
 * const endpoint = yield* Azure.Network.PrivateEndpoint("files-blob", {
 *   resourceGroup: group.resourceGroupName,
 *   subnetId: subnet.subnetId,
 *   manualPrivateLinkServiceConnections: [
 *     { privateLinkServiceId: account.storageAccountId, groupIds: ["blob"] },
 *   ],
 * });
 * yield* Azure.Storage.PrivateEndpointConnection("files-blob-approval", {
 *   resourceGroup: group.resourceGroupName,
 *   storageAccount: account.storageAccountName,
 *   privateEndpointId: endpoint.privateEndpointId,
 *   description: "Approved for the analytics VNet",
 * });
 * ```
 *
 * **Example:** Reject a request
 * ```typescript
 * yield* Azure.Storage.PrivateEndpointConnection("files-blob-approval", {
 *   resourceGroup: group.resourceGroupName,
 *   storageAccount: account.storageAccountName,
 *   privateEndpointId: endpoint.privateEndpointId,
 *   status: "Rejected",
 *   description: "Use the shared endpoint instead",
 * });
 * ```
 *
 * @resource
 */
export const PrivateEndpointConnection = Resource<PrivateEndpointConnection>(
  "Azure.Storage.PrivateEndpointConnection",
);

export class PrivateEndpointConnectionRequestMissing extends Data.TaggedError(
  "Azure.Storage.PrivateEndpointConnectionRequestMissing",
)<{ readonly message: string }> {}

type Observed = storage.GetPrivateEndpointConnectionResponse;

const sameId = (a: string | undefined, b: string) =>
  (a ?? "").toLowerCase() === b.toLowerCase();

const getConnection = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  privateEndpointConnectionName: string,
) =>
  orUndefinedIfNotFound(
    storage.GetPrivateEndpointConnection({
      subscriptionId,
      resourceGroupName,
      accountName,
      privateEndpointConnectionName,
    }),
  );

/** The account's connection for the given private endpoint. */
const findConnection = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  privateEndpointId: string,
) {
  const page = yield* orUndefinedIfNotFound(
    storage
      .ListPrivateEndpointConnections({
        subscriptionId,
        resourceGroupName,
        accountName,
      })
      .pipe(
        Effect.flatMap((page) =>
          requireSinglePage("ListPrivateEndpointConnections", page),
        ),
      ),
  );
  return (page?.value ?? []).find((connection) =>
    sameId(connection.properties?.privateEndpoint?.id, privateEndpointId),
  );
});

const toAttrs = (
  resourceGroup: string,
  storageAccount: string,
  privateEndpointId: string,
  connection: Observed,
): PrivateEndpointConnection["Attributes"] => ({
  privateEndpointConnectionName: connection.name ?? "",
  privateEndpointConnectionId: connection.id ?? "",
  storageAccount,
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
      "storageAccount",
      "resourceGroup",
      "privateEndpointId",
    ],

    // Connections disappear with their storage account or endpoint.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.storageAccount !== output.storageAccount ||
        !sameId(news.privateEndpointId, output.privateEndpointId)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const storageAccount = output?.storageAccount ?? olds?.storageAccount;
      const privateEndpointId =
        output?.privateEndpointId ?? olds?.privateEndpointId;
      if (
        resourceGroup === undefined ||
        storageAccount === undefined ||
        privateEndpointId === undefined
      ) {
        return undefined;
      }
      const observed = yield* findConnection(
        subscriptionId,
        resourceGroup,
        storageAccount,
        privateEndpointId,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        storageAccount,
        privateEndpointId,
        observed,
      );
      return (yield* isAccountOwnedByStack(
        subscriptionId,
        resourceGroup,
        storageAccount,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Storage");
      const { resourceGroup, storageAccount, privateEndpointId } = news;
      const status = news.status ?? "Approved";

      // Observe. The request appears on the account shortly after the
      // private endpoint is created; it cannot be created from this side.
      const observed = yield* findConnection(
        subscriptionId,
        resourceGroup,
        storageAccount,
        privateEndpointId,
      ).pipe(
        Effect.flatMap((found) =>
          found === undefined
            ? Effect.fail(
                new PrivateEndpointConnectionRequestMissing({
                  message: `no connection from private endpoint ${privateEndpointId} on storage account ${storageAccount}`,
                }),
              )
            : Effect.succeed(found),
        ),
        Effect.retry({
          while: (e) =>
            e._tag === "Azure.Storage.PrivateEndpointConnectionRequestMissing",
          schedule: Schedule.spaced("5 seconds"),
          times: 12,
        }),
      );
      const name = observed.name ?? "";
      const get = getConnection(
        subscriptionId,
        resourceGroup,
        storageAccount,
        name,
      );

      // Sync the decision. Azure only records the description together
      // with a status change, so a description-only change is not sent.
      const state = observed.properties?.privateLinkServiceConnectionState;
      if (state?.status !== status) {
        yield* storage.PutPrivateEndpointConnection({
          subscriptionId,
          resourceGroupName: resourceGroup,
          accountName: storageAccount,
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
      return toAttrs(resourceGroup, storageAccount, privateEndpointId, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        storage.DeletePrivateEndpointConnection({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          accountName: output.storageAccount,
          privateEndpointConnectionName: output.privateEndpointConnectionName,
        }),
      );
      yield* waitUntilGone(
        `private endpoint connection ${output.privateEndpointConnectionName}`,
        getConnection(
          subscriptionId,
          output.resourceGroup,
          output.storageAccount,
          output.privateEndpointConnectionName,
        ),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Storage.StorageAccount",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
