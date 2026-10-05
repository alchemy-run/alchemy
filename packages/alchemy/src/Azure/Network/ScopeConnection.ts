import * as network from "@distilled.cloud/azure/network";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { networkProvider } from "./generic.ts";
import {
  networkManagerChildName,
  networkManagerTags,
} from "./networkManagerShared.ts";

export interface ScopeConnectionProps {
  /** Resource group of the network manager. Changing it replaces the scope connection. */
  resourceGroup: string;
  /** Name of the parent network manager. Changing it replaces the scope connection. */
  networkManager: string;
  /**
   * Name of the scope connection. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the scope connection.
   */
  name?: string;
  /** Description. */
  description?: string;
  /** Tenant ID of the scope (subscription or management group) to connect. */
  tenantId: string;
  /**
   * Subscription (`/subscriptions/<id>`) or management group ID to add to
   * the manager's scope. Changing it replaces the connection.
   */
  resourceId: string;
}

export interface ScopeConnection extends Resource<
  "Azure.Network.ScopeConnection",
  ScopeConnectionProps,
  {
    /** Name of the scope connection. */
    scopeConnectionName: string;
    /** ARM resource ID of the scope connection. */
    scopeConnectionId: string;
    /** Name of the parent network manager. */
    networkManager: string;
    /** Resource group of the network manager. */
    resourceGroup: string;
    /** Description. */
    description: string | undefined;
    /** Connected scope. */
    resourceId: string | undefined;
    /** Connection state (`Pending` until the scope owner accepts). */
    connectionState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A scope connection on an Azure Virtual Network Manager — a request to
 * manage a subscription or management group in another tenant. It stays
 * `Pending` until the scope owner creates a matching
 * {@link NetworkManagerConnection}. It carries no tags: ownership follows
 * the network manager.
 *
 * @see https://learn.microsoft.com/azure/virtual-network-manager/concept-cross-tenant
 *
 * ### Connecting a Scope
 * **Example:** Request management of another tenant's subscription
 * ```typescript
 * yield* Azure.Network.ScopeConnection("partner", {
 *   resourceGroup: group.resourceGroupName,
 *   networkManager: manager.networkManagerName,
 *   tenantId: "00000000-0000-0000-0000-000000000000",
 *   resourceId: "/subscriptions/00000000-0000-0000-0000-000000000000",
 * });
 * ```
 *
 * @resource
 */
export const ScopeConnection = Resource<ScopeConnection>(
  "Azure.Network.ScopeConnection",
);

export const ScopeConnectionProvider = () =>
  Provider.succeed(
    ScopeConnection,
    networkProvider<ScopeConnection>()({
      label: "scope connection",
      nameAttr: "scopeConnectionName",
      parents: ["networkManager"],
      tracked: false,
      physicalName: networkManagerChildName,
      immutable: (news, output) =>
        news.resourceId.toLowerCase() !== output.resourceId?.toLowerCase(),
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetScopeConnection({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            networkManagerName: path.networkManager!,
            scopeConnectionName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.ScopeConnectionsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkManagerName: path.networkManager!,
          scopeConnectionName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteScopeConnection({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkManagerName: path.networkManager!,
          scopeConnectionName: path.name,
        }),
      ownerTags: networkManagerTags,
      body: (news) => ({
        properties: {
          description: news.description,
          tenantId: news.tenantId,
          resourceId: news.resourceId,
        },
      }),
      drifted: (observed, _body, news) =>
        (observed.properties?.description ?? undefined) !== news.description,
      toAttrs: (path, observed) => ({
        scopeConnectionName: path.name,
        scopeConnectionId: observed.id ?? "",
        networkManager: path.networkManager!,
        resourceGroup: path.resourceGroup,
        description: observed.properties?.description,
        resourceId: observed.properties?.resourceId,
        connectionState: observed.properties?.connectionState,
      }),
      dependsOn: ["Azure.Network.NetworkManager"],
    }),
  );
