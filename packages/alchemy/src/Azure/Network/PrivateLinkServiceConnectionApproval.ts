import * as network from "@distilled.cloud/azure/network";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { connectionApprovalProvider } from "./connectionApprovalShared.ts";

export interface PrivateLinkServiceConnectionApprovalProps {
  /** Resource group of the private link service. Changing it replaces the approval. */
  resourceGroup: string;
  /** Name of the private link service. Changing it replaces the approval. */
  privateLinkService: string;
  /**
   * ARM ID of the private endpoint whose connection request is answered.
   * Changing it replaces the approval.
   */
  privateEndpointId: string;
  /**
   * Answer to the request.
   * @default "Approved"
   */
  status?: "Approved" | "Rejected";
  /**
   * Message shown to the endpoint owner.
   * @default "<status> by Alchemy"
   */
  description?: string;
}

export interface PrivateLinkServiceConnectionApproval extends Resource<
  "Azure.Network.PrivateLinkServiceConnectionApproval",
  PrivateLinkServiceConnectionApprovalProps,
  {
    /** Name Azure assigned to the connection. */
    connectionName: string;
    /** ARM resource ID of the connection. */
    connectionId: string;
    /** Resource group of the private link service. */
    resourceGroup: string;
    /** Name of the private link service. */
    privateLinkService: string;
    /** ARM ID of the connected private endpoint. */
    privateEndpointId: string;
    /** Connection status (`Pending`, `Approved`, `Rejected`, `Disconnected`). */
    status: string | undefined;
    /** Message shown to the endpoint owner. */
    description: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Approves (or rejects) a manual private endpoint connection request to an
 * Azure {@link PrivateLinkService}. The connection is found by the
 * requesting private endpoint's ID; deleting the approval removes the
 * connection. Approvals carry no tags: ownership follows the service.
 *
 * @see https://learn.microsoft.com/azure/private-link/manage-private-endpoint
 *
 * ### Approving a Connection
 * **Example:** Approve a consumer's manual request
 * ```typescript
 * yield* Azure.Network.PrivateLinkServiceConnectionApproval("consumer", {
 *   resourceGroup: group.resourceGroupName,
 *   privateLinkService: service.privateLinkServiceName,
 *   privateEndpointId: endpoint.privateEndpointId,
 * });
 * ```
 *
 * @resource
 */
export const PrivateLinkServiceConnectionApproval =
  Resource<PrivateLinkServiceConnectionApproval>(
    "Azure.Network.PrivateLinkServiceConnectionApproval",
  );

export const PrivateLinkServiceConnectionApprovalProvider = () =>
  Provider.succeed(
    PrivateLinkServiceConnectionApproval,
    connectionApprovalProvider<
      PrivateLinkServiceConnectionApproval,
      network.GetPrivateLinkServicePrivateEndpointConnectionResponse
    >({
      label: "private link service",
      parent: "privateLinkService",
      list: (subscriptionId, resourceGroupName, serviceName) =>
        network.ListPrivateLinkServicePrivateEndpointConnections({
          subscriptionId,
          resourceGroupName,
          serviceName,
        }),
      get: (subscriptionId, resourceGroupName, serviceName, peConnectionName) =>
        orUndefinedIfNotFound(
          network.GetPrivateLinkServicePrivateEndpointConnection({
            subscriptionId,
            resourceGroupName,
            serviceName,
            peConnectionName,
          }),
        ),
      update: (
        subscriptionId,
        resourceGroupName,
        serviceName,
        peConnectionName,
        state,
      ) =>
        network.UpdatePrivateLinkServicePrivateEndpointConnection({
          subscriptionId,
          resourceGroupName,
          serviceName,
          peConnectionName,
          name: peConnectionName,
          properties: { privateLinkServiceConnectionState: state },
        }),
      del: (subscriptionId, resourceGroupName, serviceName, peConnectionName) =>
        network.DeletePrivateLinkServicePrivateEndpointConnection({
          subscriptionId,
          resourceGroupName,
          serviceName,
          peConnectionName,
        }),
      parentTags: (subscriptionId, resourceGroupName, serviceName) =>
        orUndefinedIfNotFound(
          network.GetPrivateLinkService({
            subscriptionId,
            resourceGroupName,
            serviceName,
          }),
        ).pipe(Effect.map((service) => service?.tags)),
      dependsOn: ["Azure.Network.PrivateLinkService"],
    }),
  );
