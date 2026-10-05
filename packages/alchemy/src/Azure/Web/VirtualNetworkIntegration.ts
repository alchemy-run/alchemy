import * as web from "@distilled.cloud/azure/web";
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
import { lower, siteWhere } from "./common.ts";

export interface VirtualNetworkIntegrationProps {
  /** Resource group of the app. Changing it replaces the integration. */
  resourceGroup: string;
  /** Name of the web app or function app. Changing it replaces it. */
  siteName: string;
  /**
   * Deployment slot of the app. Changing it replaces the integration.
   * @default the production slot
   */
  slot?: string;
  /**
   * ARM ID of the subnet the app's outbound traffic is routed through. The
   * subnet must be delegated to `Microsoft.Web/serverFarms` and be in the
   * app's region. Changing it disconnects and reconnects the app.
   */
  subnetId: string;
}

export interface VirtualNetworkIntegration extends Resource<
  "Azure.Web.VirtualNetworkIntegration",
  VirtualNetworkIntegrationProps,
  {
    /** Name of the app. */
    siteName: string;
    /** Deployment slot, if slot-scoped. */
    slot: string | undefined;
    /** Resource group of the app. */
    resourceGroup: string;
    /** ARM ID of the integrated subnet. */
    subnetId: string;
    /** Whether the app's plan supports regional VNet integration. */
    swiftSupported: boolean | undefined;
  },
  never,
  Providers
> {}

/**
 * Regional virtual network integration of an App Service app
 * (`Microsoft.Web/sites/networkConfig/virtualNetwork`): routes the app's
 * outbound traffic through a delegated subnet. Requires a Basic or higher
 * plan.
 *
 * For the production slot, the `virtualNetworkSubnetId` prop of
 * `Web.WebApp` is equivalent; use this resource for slots or when the
 * integration is managed separately from the app.
 *
 * @see https://learn.microsoft.com/azure/app-service/overview-vnet-integration
 *
 * ### Integrating an App with a Subnet
 * **Example:** Delegated subnet
 * ```typescript
 * const vnet = yield* Azure.Network.VirtualNetwork("vnet", {
 *   resourceGroup: group.resourceGroupName,
 *   addressPrefixes: ["10.0.0.0/16"],
 * });
 * const subnet = yield* Azure.Network.Subnet("apps", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualNetwork: vnet.virtualNetworkName,
 *   addressPrefix: "10.0.1.0/24",
 *   delegations: [{ serviceName: "Microsoft.Web/serverFarms" }],
 * });
 * yield* Azure.Web.VirtualNetworkIntegration("vnet-integration", {
 *   resourceGroup: group.resourceGroupName,
 *   siteName: app.siteName,
 *   subnetId: subnet.subnetId,
 * });
 * ```
 *
 * @resource
 */
export const VirtualNetworkIntegration = Resource<VirtualNetworkIntegration>(
  "Azure.Web.VirtualNetworkIntegration",
);

const getIntegration = (
  subscriptionId: string,
  resourceGroup: string,
  siteName: string,
  slot: string | undefined,
) => {
  const where = siteWhere(subscriptionId, resourceGroup, siteName);
  return orUndefinedIfNotFound(
    slot === undefined
      ? web.GetWebAppSwiftVirtualNetworkConnection(where)
      : web.GetWebAppSwiftVirtualNetworkConnectionSlot({ ...where, slot }),
  ).pipe(
    // An app without integration reports an empty connection.
    Effect.map((observed) =>
      observed?.properties?.subnetResourceId ? observed : undefined,
    ),
  );
};

const toAttrs = (
  resourceGroup: string,
  siteName: string,
  slot: string | undefined,
  observed: web.GetWebAppSwiftVirtualNetworkConnectionResponse,
) => ({
  siteName,
  slot,
  resourceGroup,
  subnetId: observed.properties?.subnetResourceId ?? "",
  swiftSupported: observed.properties?.swiftSupported,
});

const disconnect = (
  subscriptionId: string,
  resourceGroup: string,
  siteName: string,
  slot: string | undefined,
) =>
  Effect.gen(function* () {
    const where = siteWhere(subscriptionId, resourceGroup, siteName);
    yield* ignoreNotFound(
      slot === undefined
        ? web.DeleteWebAppSwiftVirtualNetwork(where)
        : web.DeleteWebAppSwiftVirtualNetworkSlot({ ...where, slot }),
    );
    yield* waitUntilGone(
      `VNet integration of ${siteName}`,
      getIntegration(subscriptionId, resourceGroup, siteName, slot),
    );
  });

export const VirtualNetworkIntegrationProvider = () =>
  Provider.succeed(VirtualNetworkIntegration, {
    stables: ["siteName", "slot", "resourceGroup"],

    // The integration is removed with its app.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.siteName) !== lower(output.siteName) ||
        lower(news.slot) !== lower(output.slot)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const siteName = output?.siteName ?? olds?.siteName;
      if (!resourceGroup || !siteName) return undefined;
      const slot = output?.slot ?? olds?.slot;
      const observed = yield* getIntegration(
        subscriptionId,
        resourceGroup,
        siteName,
        slot,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, siteName, slot, observed);
      // A singleton without tags; only one this stack recorded is ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Web");
      const { resourceGroup, siteName, slot, subnetId } = news;
      const get = getIntegration(subscriptionId, resourceGroup, siteName, slot);

      // Observe.
      const observed = yield* get;
      const current = observed?.properties?.subnetResourceId;

      // Moving to another subnet: App Service only connects an app that is
      // not connected yet, so disconnect first.
      if (current !== undefined && lower(current) !== lower(subnetId)) {
        yield* disconnect(subscriptionId, resourceGroup, siteName, slot);
      }

      // Ensure.
      if (current === undefined || lower(current) !== lower(subnetId)) {
        const where = {
          ...siteWhere(subscriptionId, resourceGroup, siteName),
          properties: { subnetResourceId: subnetId },
        };
        yield* slot === undefined
          ? web.WebAppsCreateOrUpdateSwiftVirtualNetworkConnectionWithCheck(
              where,
            )
          : web.WebAppsCreateOrUpdateSwiftVirtualNetworkConnectionWithCheckSlot(
              { ...where, slot },
            );
      }

      const final = yield* waitForProvisioned(
        `VNet integration of ${siteName}`,
        get,
        (value) =>
          lower(value.properties?.subnetResourceId) === lower(subnetId)
            ? undefined
            : "InProgress",
        { interval: "5 seconds", times: 24 },
      );
      return toAttrs(resourceGroup, siteName, slot, final);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* disconnect(
        subscriptionId,
        output.resourceGroup,
        output.siteName,
        output.slot,
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
