import * as network from "@distilled.cloud/azure/network";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { connectionApprovalProvider } from "./connectionApprovalShared.ts";

export interface ApplicationGatewayConnectionApprovalProps {
  /** Resource group of the application gateway. Changing it replaces the approval. */
  resourceGroup: string;
  /** Name of the application gateway. Changing it replaces the approval. */
  applicationGateway: string;
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

export interface ApplicationGatewayConnectionApproval extends Resource<
  "Azure.Network.ApplicationGatewayConnectionApproval",
  ApplicationGatewayConnectionApprovalProps,
  {
    /** Name Azure assigned to the connection. */
    connectionName: string;
    /** ARM resource ID of the connection. */
    connectionId: string;
    /** Resource group of the application gateway. */
    resourceGroup: string;
    /** Name of the application gateway. */
    applicationGateway: string;
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
 * Azure Application Gateway with a private link configuration. The
 * connection is found by the requesting private endpoint's ID; deleting
 * the approval removes the connection. Approvals carry no tags: ownership
 * follows the gateway.
 *
 * @see https://learn.microsoft.com/azure/application-gateway/private-link
 *
 * ### Approving a Connection
 * **Example:** Approve a consumer's manual request
 * ```typescript
 * yield* Azure.Network.ApplicationGatewayConnectionApproval("consumer", {
 *   resourceGroup: group.resourceGroupName,
 *   applicationGateway: gateway.applicationGatewayName,
 *   privateEndpointId: endpoint.privateEndpointId,
 * });
 * ```
 *
 * @resource
 */
export const ApplicationGatewayConnectionApproval =
  Resource<ApplicationGatewayConnectionApproval>(
    "Azure.Network.ApplicationGatewayConnectionApproval",
  );

export const ApplicationGatewayConnectionApprovalProvider = () =>
  Provider.succeed(
    ApplicationGatewayConnectionApproval,
    connectionApprovalProvider<
      ApplicationGatewayConnectionApproval,
      network.GetApplicationGatewayPrivateEndpointConnectionResponse
    >({
      label: "application gateway",
      parent: "applicationGateway",
      list: (subscriptionId, resourceGroupName, applicationGatewayName) =>
        network.ListApplicationGatewayPrivateEndpointConnections({
          subscriptionId,
          resourceGroupName,
          applicationGatewayName,
        }),
      get: (
        subscriptionId,
        resourceGroupName,
        applicationGatewayName,
        connectionName,
      ) =>
        orUndefinedIfNotFound(
          network.GetApplicationGatewayPrivateEndpointConnection({
            subscriptionId,
            resourceGroupName,
            applicationGatewayName,
            connectionName,
          }),
        ),
      update: (
        subscriptionId,
        resourceGroupName,
        applicationGatewayName,
        connectionName,
        state,
      ) =>
        network.UpdateApplicationGatewayPrivateEndpointConnection({
          subscriptionId,
          resourceGroupName,
          applicationGatewayName,
          connectionName,
          name: connectionName,
          properties: { privateLinkServiceConnectionState: state },
        }),
      del: (
        subscriptionId,
        resourceGroupName,
        applicationGatewayName,
        connectionName,
      ) =>
        network.DeleteApplicationGatewayPrivateEndpointConnection({
          subscriptionId,
          resourceGroupName,
          applicationGatewayName,
          connectionName,
        }),
      parentTags: (subscriptionId, resourceGroupName, applicationGatewayName) =>
        orUndefinedIfNotFound(
          network.GetApplicationGateway({
            subscriptionId,
            resourceGroupName,
            applicationGatewayName,
          }),
        ).pipe(Effect.map((gateway) => gateway?.tags)),
      dependsOn: ["Azure.Network.ApplicationGateway"],
    }),
  );
