import * as web from "@distilled.cloud/azure/web";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
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
import { lower } from "./common.ts";

/** Kind of a virtual network route of an App Service plan. */
export type VirtualNetworkRouteType = "DEFAULT" | "INHERITED" | "STATIC";

export interface VirtualNetworkRouteProps {
  /** Resource group of the App Service plan. Changing it replaces the route. */
  resourceGroup: string;
  /** Name of the App Service plan. Changing it replaces the route. */
  appServicePlanName: string;
  /**
   * Name of the plan's virtual network connection: the `vnetName` of a
   * `GatewayVirtualNetworkIntegration` of an app on the plan. Changing it
   * replaces the route.
   */
  vnetName: string;
  /**
   * Name of the route. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the route.
   */
  name?: string;
  /**
   * First address of the range, or a CIDR block (then omit `endAddress`),
   * e.g. `10.0.0.0/16`.
   */
  startAddress: string;
  /** Last address of the range when `startAddress` is not a CIDR block. */
  endAddress?: string;
  /**
   * `STATIC` (set on the plan only), `INHERITED` (from the virtual
   * network), or `DEFAULT` (the RFC 1918 ranges).
   * @default "STATIC"
   */
  routeType?: VirtualNetworkRouteType;
}

export interface VirtualNetworkRoute extends Resource<
  "Azure.Web.VirtualNetworkRoute",
  VirtualNetworkRouteProps,
  {
    /** Name of the route. */
    routeName: string;
    /** ARM resource ID of the route. */
    routeId: string;
    /** Name of the App Service plan. */
    appServicePlanName: string;
    /** Name of the plan's virtual network connection. */
    vnetName: string;
    /** Resource group of the plan. */
    resourceGroup: string;
    /** First address (or CIDR block) of the range. */
    startAddress: string | undefined;
    /** Last address of the range. */
    endAddress: string | undefined;
    /** Kind of the route. */
    routeType: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An address range an App Service plan routes into a gateway-required
 * virtual network connection
 * (`Microsoft.Web/serverfarms/virtualNetworkConnections/routes`). Every app
 * on the plan that uses the connection sends traffic for the range through
 * the point-to-site VPN. The connection must exist: create a
 * `GatewayVirtualNetworkIntegration` on an app of the plan first.
 *
 * :::caution
 * Changing `resourceGroup`, `appServicePlanName`, `vnetName`, or `name`
 * replaces the route.
 * :::
 *
 * @see https://learn.microsoft.com/azure/app-service/configure-gateway-required-vnet-integration
 *
 * ### Routing an Address Range
 * **Example:** Send 10.20.0.0/16 through the VPN
 * ```typescript
 * yield* Azure.Web.VirtualNetworkRoute("onprem", {
 *   appServicePlanName: plan.appServicePlanName,
 *   vnetName: integration.vnetName,
 *   startAddress: "10.20.0.0/16",
 * });
 * ```
 *
 * @resource
 */
export const VirtualNetworkRoute = GroupedResource<VirtualNetworkRoute>(
  "Azure.Web.VirtualNetworkRoute",
);

type ObservedRoute = web.VnetRoute;

const createRouteName = (id: string) => createPhysicalName({ id, maxLength: 60, lowercase: true });

const planWhere = (
  subscriptionId: string,
  resourceGroup: string,
  appServicePlanName: string,
  vnetName: string,
  routeName: string,
) => ({
  subscriptionId,
  resourceGroupName: resourceGroup,
  name: appServicePlanName,
  vnetName,
  routeName,
});

const getRoute = (where: ReturnType<typeof planWhere>) =>
  orUndefinedIfNotFound(web.GetAppServicePlanRouteForVnet(where)).pipe(
    // The GET answers with a one-element list.
    Effect.map((routes) => routes?.[0]),
  );

const toAttrs = (
  where: ReturnType<typeof planWhere>,
  observed: ObservedRoute,
): VirtualNetworkRoute["Attributes"] => ({
  routeName: where.routeName,
  routeId: observed.id ?? "",
  appServicePlanName: where.name,
  vnetName: where.vnetName,
  resourceGroup: where.resourceGroupName,
  startAddress: observed.properties?.startAddress,
  endAddress: observed.properties?.endAddress,
  routeType: observed.properties?.routeType,
});

export const VirtualNetworkRouteProvider = () =>
  Provider.succeed(VirtualNetworkRoute, {
    stables: ["routeName", "routeId", "appServicePlanName", "vnetName", "resourceGroup"],

    // Routes are removed with their plan's connection.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.appServicePlanName) !== lower(output.appServicePlanName) ||
        lower(news.vnetName) !== lower(output.vnetName) ||
        (news.name !== undefined && lower(news.name) !== lower(output.routeName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const appServicePlanName = output?.appServicePlanName ?? olds?.appServicePlanName;
      const vnetName = output?.vnetName ?? olds?.vnetName;
      if (
        resourceGroup === undefined ||
        appServicePlanName === undefined ||
        vnetName === undefined
      ) {
        return undefined;
      }
      const routeName = output?.routeName ?? olds?.name ?? (yield* createRouteName(id));
      const where = planWhere(
        subscriptionId,
        resourceGroup,
        appServicePlanName,
        vnetName,
        routeName,
      );
      const observed = yield* getRoute(where);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(where, observed);
      // Routes carry no tags; only one this stack recorded is ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Web");
      const routeName = news.name ?? output?.routeName ?? (yield* createRouteName(id));
      const where = planWhere(
        subscriptionId,
        news.resourceGroup,
        news.appServicePlanName,
        news.vnetName,
        routeName,
      );
      const desired: web.VnetRouteProperties = {
        startAddress: news.startAddress,
        endAddress: news.endAddress,
        routeType: news.routeType ?? "STATIC",
      };

      // Observe.
      const observed = yield* getRoute(where);

      // Ensure + sync (synchronous PUT / PATCH), only on drift.
      if (observed === undefined) {
        yield* web.AppServicePlansCreateOrUpdateVnetRoute({ ...where, properties: desired });
      } else if (
        observed.properties?.startAddress !== desired.startAddress ||
        (observed.properties?.endAddress ?? undefined) !== desired.endAddress ||
        lower(observed.properties?.routeType) !== lower(desired.routeType)
      ) {
        yield* web.UpdateAppServicePlanVnetRoute({ ...where, properties: desired });
      }
      const final = yield* waitForProvisioned(
        `virtual network route ${routeName}`,
        getRoute(where),
        () => undefined,
      );
      return toAttrs(where, final);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where = planWhere(
        subscriptionId,
        output.resourceGroup,
        output.appServicePlanName,
        output.vnetName,
        output.routeName,
      );
      yield* ignoreNotFound(web.DeleteAppServicePlanVnetRoute(where));
      yield* waitUntilGone(`virtual network route ${output.routeName}`, getRoute(where));
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.Web.AppServicePlan",
        "Azure.Web.GatewayVirtualNetworkIntegration",
      ],
    },
  });
