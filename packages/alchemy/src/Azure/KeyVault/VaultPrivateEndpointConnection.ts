import * as keyvault from "@distilled.cloud/azure/keyvault";
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
import { isVaultOwnedByStack, lower, sameId } from "./common.ts";

export interface VaultPrivateEndpointConnectionProps {
  /** Resource group of the vault. Changing it replaces the connection. */
  resourceGroup: string;
  /** Vault the private endpoint connects to. Changing it replaces the connection. */
  vault: string;
  /**
   * ARM ID of the private endpoint whose connection request is managed.
   * Changing it replaces the connection.
   */
  privateEndpointId: string;
  /**
   * Decision on the connection request.
   * @default "Approved"
   */
  status?: "Approved" | "Rejected";
  /**
   * Reason for the decision, shown to the private endpoint's owner.
   * @default unmanaged
   */
  description?: string;
}

export interface VaultPrivateEndpointConnection extends Resource<
  "Azure.KeyVault.VaultPrivateEndpointConnection",
  VaultPrivateEndpointConnectionProps,
  {
    /** Name of the connection (assigned by Azure). */
    privateEndpointConnectionName: string;
    /** ARM resource ID of the connection. */
    privateEndpointConnectionId: string;
    /** Vault the private endpoint connects to. */
    vault: string;
    /** Resource group of the vault. */
    resourceGroup: string;
    /** ARM ID of the private endpoint. */
    privateEndpointId: string;
    /** Observed status: `Pending`, `Approved`, `Rejected`, or `Disconnected`. */
    status: string | undefined;
    /** Observed reason for the decision. */
    description: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Approval of a private endpoint's connection to an Azure Key Vault.
 *
 * Connections are not created directly: a private endpoint that targets
 * the vault with a *manual* connection leaves a `Pending` request on the
 * vault. This resource approves or rejects that request. Destroying it
 * removes the connection, which disconnects the private endpoint.
 *
 * @see https://learn.microsoft.com/azure/key-vault/general/private-link-service
 *
 * ### Approving Connections
 * **Example:** Approve a manual private endpoint request
 * ```typescript
 * const endpoint = yield* Azure.Network.PrivateEndpoint("vault-pe", {
 *   resourceGroup: group.resourceGroupName,
 *   subnetId: subnet.subnetId,
 *   manualPrivateLinkServiceConnections: [
 *     { privateLinkServiceId: vault.vaultId, groupIds: ["vault"] },
 *   ],
 * });
 * yield* Azure.KeyVault.VaultPrivateEndpointConnection("vault-pe-approval", {
 *   resourceGroup: group.resourceGroupName,
 *   vault: vault.vaultName,
 *   privateEndpointId: endpoint.privateEndpointId,
 *   description: "Approved for the app VNet",
 * });
 * ```
 *
 * **Example:** Reject a request
 * ```typescript
 * yield* Azure.KeyVault.VaultPrivateEndpointConnection("vault-pe-approval", {
 *   resourceGroup: group.resourceGroupName,
 *   vault: vault.vaultName,
 *   privateEndpointId: endpoint.privateEndpointId,
 *   status: "Rejected",
 *   description: "Use the shared endpoint instead",
 * });
 * ```
 *
 * @resource
 */
export const VaultPrivateEndpointConnection =
  Resource<VaultPrivateEndpointConnection>(
    "Azure.KeyVault.VaultPrivateEndpointConnection",
  );

export class VaultPrivateEndpointConnectionRequestMissing extends Data.TaggedError(
  "Azure.KeyVault.VaultPrivateEndpointConnectionRequestMissing",
)<{ readonly message: string }> {}

type Observed = keyvault.GetPrivateEndpointConnectionResponse;

const getConnection = (
  subscriptionId: string,
  resourceGroupName: string,
  vaultName: string,
  privateEndpointConnectionName: string,
) =>
  orUndefinedIfNotFound(
    keyvault.GetPrivateEndpointConnection({
      subscriptionId,
      resourceGroupName,
      vaultName,
      privateEndpointConnectionName,
    }),
  );

const findConnection = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  vaultName: string,
  privateEndpointId: string,
) {
  const page = yield* orUndefinedIfNotFound(
    keyvault
      .ListPrivateEndpointConnectionByResource({
        subscriptionId,
        resourceGroupName,
        vaultName,
      })
      .pipe(
        Effect.flatMap((page) =>
          requireSinglePage("ListPrivateEndpointConnectionByResource", page),
        ),
      ),
  );
  return (page?.value ?? []).find((connection) =>
    sameId(connection.properties?.privateEndpoint?.id, privateEndpointId),
  );
});

const toAttrs = (
  resourceGroup: string,
  vault: string,
  privateEndpointId: string,
  connection: Observed,
): VaultPrivateEndpointConnection["Attributes"] => ({
  privateEndpointConnectionName: connection.name ?? "",
  privateEndpointConnectionId: connection.id ?? "",
  vault,
  resourceGroup,
  privateEndpointId,
  status: connection.properties?.privateLinkServiceConnectionState?.status,
  description:
    connection.properties?.privateLinkServiceConnectionState?.description,
});

export const VaultPrivateEndpointConnectionProvider = () =>
  Provider.succeed(VaultPrivateEndpointConnection, {
    stables: [
      "privateEndpointConnectionName",
      "privateEndpointConnectionId",
      "vault",
      "resourceGroup",
      "privateEndpointId",
    ],

    // Connections disappear with their vault or endpoint.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.vault) !== lower(output.vault) ||
        !sameId(news.privateEndpointId, output.privateEndpointId)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const vault = output?.vault ?? olds?.vault;
      const privateEndpointId =
        output?.privateEndpointId ?? olds?.privateEndpointId;
      if (
        resourceGroup === undefined ||
        vault === undefined ||
        privateEndpointId === undefined
      ) {
        return undefined;
      }
      const observed = yield* findConnection(
        subscriptionId,
        resourceGroup,
        vault,
        privateEndpointId,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, vault, privateEndpointId, observed);
      return (yield* isVaultOwnedByStack(subscriptionId, resourceGroup, vault))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.KeyVault");
      const { resourceGroup, vault, privateEndpointId } = news;
      const status = news.status ?? "Approved";

      // Observe. The request appears on the vault shortly after the
      // private endpoint is created; it cannot be created from this side.
      const observed = yield* findConnection(
        subscriptionId,
        resourceGroup,
        vault,
        privateEndpointId,
      ).pipe(
        Effect.flatMap((found) =>
          found === undefined
            ? Effect.fail(
                new VaultPrivateEndpointConnectionRequestMissing({
                  message: `no connection from private endpoint ${privateEndpointId} on key vault ${vault}`,
                }),
              )
            : Effect.succeed(found),
        ),
        Effect.retry({
          while: (e) =>
            e._tag ===
            "Azure.KeyVault.VaultPrivateEndpointConnectionRequestMissing",
          schedule: Schedule.spaced("5 seconds"),
          times: 12,
        }),
      );
      const name = observed.name ?? "";
      const get = getConnection(subscriptionId, resourceGroup, vault, name);

      // Sync the decision and its description.
      const state = observed.properties?.privateLinkServiceConnectionState;
      if (
        state?.status !== status ||
        (news.description !== undefined &&
          state?.description !== news.description)
      ) {
        yield* keyvault.PutPrivateEndpointConnection({
          subscriptionId,
          resourceGroupName: resourceGroup,
          vaultName: vault,
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
          connection.properties?.privateLinkServiceConnectionState?.status ===
          status
            ? connection.properties.provisioningState
            : "Updating",
        { interval: "3 seconds", times: 40 },
      );
      return toAttrs(resourceGroup, vault, privateEndpointId, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        keyvault.DeletePrivateEndpointConnection({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          vaultName: output.vault,
          privateEndpointConnectionName: output.privateEndpointConnectionName,
        }),
      );
      yield* waitUntilGone(
        `private endpoint connection ${output.privateEndpointConnectionName}`,
        getConnection(
          subscriptionId,
          output.resourceGroup,
          output.vault,
          output.privateEndpointConnectionName,
        ),
      );
    }),

    nuke: {
      dependsOn: ["Azure.KeyVault.Vault", "Azure.Resources.ResourceGroup"],
    },
  });
