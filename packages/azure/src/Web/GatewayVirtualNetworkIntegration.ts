import * as web from "@distilled.cloud/azure/web";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { lower, nameOf, siteWhere } from "./common.ts";

export interface GatewayVirtualNetworkIntegrationProps {
  /** Resource group of the app. Changing it replaces the integration. */
  resourceGroup: string;
  /** Name of the Windows web app or function app. Changing it replaces it. */
  siteName: string;
  /**
   * Deployment slot of the app. Changing it replaces the integration.
   * @default the production slot
   */
  slot?: string;
  /**
   * ARM ID of the virtual network. It must have a virtual network gateway
   * with point-to-site VPN enabled before traffic flows. Changing it
   * replaces the integration.
   */
  virtualNetworkId: string;
  /**
   * URI of the point-to-site VPN client package of the virtual network
   * gateway (a SAS URL from `GenerateVpnClientPackage`). Setting it
   * connects the app to the gateway (`virtualNetworkConnections/gateways/primary`).
   * @default not connected to a gateway
   */
  vpnPackageUri?: string;
}

export interface GatewayVirtualNetworkIntegration extends Resource<
  "Azure.Web.GatewayVirtualNetworkIntegration",
  GatewayVirtualNetworkIntegrationProps,
  {
    /** ARM resource ID of the connection on the app. */
    connectionId: string;
    /** Name of the connection (the virtual network's name). */
    vnetName: string;
    /** Name of the app. */
    siteName: string;
    /** Deployment slot, if slot-scoped. */
    slot: string | undefined;
    /** Resource group of the app. */
    resourceGroup: string;
    /** ARM ID of the virtual network. */
    virtualNetworkId: string;
    /** Thumbprint of the app's point-to-site client certificate. */
    certThumbprint: string | undefined;
    /**
     * Base64-encoded public certificate of the app; add it as a root
     * certificate of the gateway's point-to-site configuration.
     */
    certBlob: string | undefined;
    /** Whether the app must resync its routes with the virtual network. */
    resyncRequired: boolean;
  },
  never,
  Providers
> {}

/**
 * Gateway-required virtual network integration of a Windows App Service app
 * (`Microsoft.Web/sites/virtualNetworkConnections`, or
 * `sites/slots/virtualNetworkConnections` with `slot`): the app reaches a
 * virtual network, in any region, through a point-to-site VPN to the
 * network's virtual network gateway. Prefer `Azure.Web.VirtualNetworkIntegration`
 * (regional integration) unless the network is in another region or is a
 * classic network. Requires a Standard or higher Windows plan.
 *
 * App Service generates the app's point-to-site client certificate; a
 * connection PUT with another `certBlob` keeps the generated one. Add the
 * returned `certBlob` as a point-to-site root certificate of the gateway,
 * then set `vpnPackageUri` to connect the app. Set custom DNS servers with
 * the app's `WEBSITE_DNS_SERVER` app setting: Microsoft.Web does not persist
 * the connection's own `dnsServers` field (a GET after a PUT or PATCH
 * reports none).
 *
 * :::caution
 * Changing `resourceGroup`, `siteName`, `slot`, or `virtualNetworkId`
 * replaces the integration.
 * :::
 *
 * @see https://learn.microsoft.com/azure/app-service/configure-gateway-required-vnet-integration
 *
 * ### Connecting through a Gateway
 * **Example:** Register the connection
 * ```typescript
 * const integration = yield* Azure.Web.GatewayVirtualNetworkIntegration("vpn", {
 *   siteName: app.siteName,
 *   virtualNetworkId: vnet.virtualNetworkId,
 * });
 * // integration.certBlob is the app's point-to-site client certificate
 * ```
 *
 * **Example:** Connect to the gateway's VPN package
 * ```typescript
 * yield* Azure.Web.GatewayVirtualNetworkIntegration("vpn", {
 *   siteName: app.siteName,
 *   virtualNetworkId: vnet.virtualNetworkId,
 *   vpnPackageUri: packageSasUrl,
 * });
 * ```
 *
 * @resource
 */
export const GatewayVirtualNetworkIntegration = GroupedResource<GatewayVirtualNetworkIntegration>(
  "Azure.Web.GatewayVirtualNetworkIntegration",
);

type ObservedConnection = web.GetWebAppVnetConnectionResponse;

/** The primary (and only) gateway of a connection. */
const GATEWAY = "primary";

const getConnection = (
  subscriptionId: string,
  resourceGroup: string,
  siteName: string,
  slot: string | undefined,
  vnetName: string,
) => {
  const where = { ...siteWhere(subscriptionId, resourceGroup, siteName), vnetName };
  return orUndefinedIfNotFound(
    slot === undefined
      ? web.GetWebAppVnetConnection(where)
      : web.GetWebAppVnetConnectionSlot({ ...where, slot }),
  );
};

const toAttrs = (
  resourceGroup: string,
  siteName: string,
  slot: string | undefined,
  vnetName: string,
  virtualNetworkId: string,
  observed: ObservedConnection,
): GatewayVirtualNetworkIntegration["Attributes"] => ({
  connectionId: observed.id ?? "",
  vnetName,
  siteName,
  slot,
  resourceGroup,
  virtualNetworkId: observed.properties?.vnetResourceId ?? virtualNetworkId,
  certThumbprint: observed.properties?.certThumbprint,
  certBlob: observed.properties?.certBlob,
  resyncRequired: observed.properties?.resyncRequired ?? false,
});

export const GatewayVirtualNetworkIntegrationProvider = () =>
  Provider.succeed(GatewayVirtualNetworkIntegration, {
    stables: ["connectionId", "vnetName", "siteName", "slot", "resourceGroup", "virtualNetworkId"],

    // Connections are removed with their app.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.siteName) !== lower(output.siteName) ||
        lower(news.slot) !== lower(output.slot) ||
        lower(news.virtualNetworkId) !== lower(output.virtualNetworkId)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const siteName = output?.siteName ?? olds?.siteName;
      const virtualNetworkId = output?.virtualNetworkId ?? olds?.virtualNetworkId;
      const vnetName = output?.vnetName ?? nameOf(virtualNetworkId);
      if (
        resourceGroup === undefined ||
        siteName === undefined ||
        virtualNetworkId === undefined ||
        vnetName === undefined
      ) {
        return undefined;
      }
      const slot = output?.slot ?? olds?.slot;
      const observed = yield* getConnection(
        subscriptionId,
        resourceGroup,
        siteName,
        slot,
        vnetName,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, siteName, slot, vnetName, virtualNetworkId, observed);
      // Connections carry no tags; only one this stack recorded is ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news, olds }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Web");
      const { resourceGroup, siteName, slot, virtualNetworkId } = news;
      const vnetName = nameOf(virtualNetworkId) ?? virtualNetworkId;
      const where = { ...siteWhere(subscriptionId, resourceGroup, siteName), vnetName };
      const get = getConnection(subscriptionId, resourceGroup, siteName, slot, vnetName);

      // Observe.
      const observed = yield* get;

      // Ensure. The connection has no mutable settings of its own (App
      // Service keeps its generated certificate and drops `dnsServers`).
      if (observed === undefined) {
        const request = {
          ...where,
          properties: { vnetResourceId: virtualNetworkId, isSwift: false },
        };
        yield* slot === undefined
          ? web.WebAppsCreateOrUpdateVnetConnection(request)
          : web.WebAppsCreateOrUpdateVnetConnectionSlot({ ...request, slot });
      }

      // Sync the gateway. The VPN package URI is a write-only SAS URL, so
      // the previous props are the baseline when the gateway exists.
      if (news.vpnPackageUri !== undefined) {
        const gatewayWhere = { ...where, gatewayName: GATEWAY };
        const gateway = yield* orUndefinedIfNotFound(
          slot === undefined
            ? web.GetWebAppVnetConnectionGateway(gatewayWhere)
            : web.GetWebAppVnetConnectionGatewaySlot({ ...gatewayWhere, slot }),
        );
        if (gateway === undefined || olds?.vpnPackageUri !== news.vpnPackageUri) {
          const request = {
            ...gatewayWhere,
            properties: { vnetName, vpnPackageUri: news.vpnPackageUri },
          };
          yield* slot === undefined
            ? web.WebAppsCreateOrUpdateVnetConnectionGateway(request)
            : web.WebAppsCreateOrUpdateVnetConnectionGatewaySlot({ ...request, slot });
        }
      }

      const final = yield* waitForProvisioned(
        `virtual network connection ${vnetName}`,
        get,
        () => undefined,
        { interval: "3 seconds", times: 20 },
      );
      return toAttrs(resourceGroup, siteName, slot, vnetName, virtualNetworkId, final);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where = {
        ...siteWhere(subscriptionId, output.resourceGroup, output.siteName),
        vnetName: output.vnetName,
      };
      yield* ignoreNotFound(
        output.slot === undefined
          ? web.DeleteWebAppVnetConnection(where)
          : web.DeleteWebAppVnetConnectionSlot({ ...where, slot: output.slot }),
      );
      yield* waitUntilGone(
        `virtual network connection ${output.vnetName}`,
        getConnection(
          subscriptionId,
          output.resourceGroup,
          output.siteName,
          output.slot,
          output.vnetName,
        ),
        { interval: "5 seconds", times: 24 },
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.Web.WebApp",
        "Azure.Web.FunctionApp",
        "Azure.Web.WebAppSlot",
      ],
    },
  });
