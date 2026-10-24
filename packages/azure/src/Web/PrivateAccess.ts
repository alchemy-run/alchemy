import * as web from "@distilled.cloud/azure/web";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { ensureRegistered, ignoreNotFound, orUndefinedIfNotFound } from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { isSiteOwnedByStack, lower, nameOf, siteWhere } from "./common.ts";

/** A virtual network allowed to reach the app privately. */
export interface PrivateAccessVirtualNetwork {
  /** ARM ID of the virtual network. */
  virtualNetworkId: string;
  /**
   * Names of the subnets allowed to reach the app.
   * @default every subnet of the virtual network
   */
  subnets?: string[];
}

export interface PrivateAccessProps {
  /** Resource group of the app. Changing it replaces the resource. */
  resourceGroup: string;
  /** Name of the web app or function app. Changing it replaces the resource. */
  siteName: string;
  /**
   * Deployment slot of the app. Changing it replaces the resource.
   * @default the production slot
   */
  slot?: string;
  /**
   * Whether private access is enabled.
   * @default true
   */
  enabled?: boolean;
  /** Virtual networks (and subnets) allowed to reach the app privately. */
  virtualNetworks: PrivateAccessVirtualNetwork[];
}

export interface PrivateAccess extends Resource<
  "Azure.Web.PrivateAccess",
  PrivateAccessProps,
  {
    /** Name of the app. */
    siteName: string;
    /** Deployment slot, if slot-scoped. */
    slot: string | undefined;
    /** Resource group of the app. */
    resourceGroup: string;
    /** Whether private access is enabled. */
    enabled: boolean;
    /** ARM IDs of the allowed virtual networks. */
    virtualNetworkIds: string[];
  },
  never,
  Providers
> {}

/**
 * Private site access of an App Service app
 * (`Microsoft.Web/sites/privateAccess/virtualNetworks`, or
 * `sites/slots/privateAccess` with `slot`): the virtual networks and subnets
 * allowed to reach the app privately. Each app (and each slot) has exactly
 * one; deleting this resource disables private access and clears the list.
 *
 * :::caution
 * Changing `resourceGroup`, `siteName`, or `slot` replaces the resource.
 * :::
 *
 * @see https://learn.microsoft.com/rest/api/appservice/web-apps/put-private-access-vnet
 *
 * ### Allowing a Virtual Network
 * **Example:** One virtual network, every subnet
 * ```typescript
 * yield* Azure.Web.PrivateAccess("private", {
 *   siteName: app.siteName,
 *   virtualNetworks: [{ virtualNetworkId: vnet.virtualNetworkId }],
 * });
 * ```
 *
 * **Example:** Selected subnets only
 * ```typescript
 * yield* Azure.Web.PrivateAccess("private", {
 *   siteName: app.siteName,
 *   virtualNetworks: [
 *     { virtualNetworkId: vnet.virtualNetworkId, subnets: ["apps"] },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const PrivateAccess = GroupedResource<PrivateAccess>("Azure.Web.PrivateAccess");

type ObservedAccess = web.GetWebAppPrivateAccessResponse;

const getAccess = (
  subscriptionId: string,
  resourceGroup: string,
  siteName: string,
  slot: string | undefined,
) => {
  const where = siteWhere(subscriptionId, resourceGroup, siteName);
  return orUndefinedIfNotFound(
    slot === undefined
      ? web.GetWebAppPrivateAccess(where)
      : web.GetWebAppPrivateAccessSlot({ ...where, slot }),
  );
};

const putAccess = (
  subscriptionId: string,
  resourceGroup: string,
  siteName: string,
  slot: string | undefined,
  properties: web.PrivateAccessProperties,
) => {
  const request = { ...siteWhere(subscriptionId, resourceGroup, siteName), properties };
  return slot === undefined
    ? web.PutWebAppPrivateAccessVnet(request)
    : web.PutWebAppPrivateAccessVnetSlot({ ...request, slot });
};

const toProperties = (props: PrivateAccessProps): web.PrivateAccessProperties => ({
  enabled: props.enabled ?? true,
  virtualNetworks: props.virtualNetworks.map((vnet) => ({
    name: nameOf(vnet.virtualNetworkId),
    resourceId: vnet.virtualNetworkId,
    subnets: (vnet.subnets ?? []).map((name) => ({ name })),
  })),
});

/** Comparable form: enabled flag + sorted `vnetId:subnet,subnet` entries. */
const fingerprint = (properties: web.PrivateAccessProperties | undefined) =>
  JSON.stringify({
    enabled: properties?.enabled ?? false,
    virtualNetworks: (properties?.virtualNetworks ?? [])
      .map(
        (vnet) =>
          `${lower(vnet.resourceId)}:${(vnet.subnets ?? [])
            .map((subnet) => lower(subnet.name))
            .sort()
            .join(",")}`,
      )
      .sort(),
  });

const toAttrs = (
  resourceGroup: string,
  siteName: string,
  slot: string | undefined,
  observed: ObservedAccess | undefined,
): PrivateAccess["Attributes"] => ({
  siteName,
  slot,
  resourceGroup,
  enabled: observed?.properties?.enabled ?? false,
  virtualNetworkIds: (observed?.properties?.virtualNetworks ?? []).flatMap((vnet) =>
    vnet.resourceId ? [vnet.resourceId] : [],
  ),
});

export const PrivateAccessProvider = () =>
  Provider.succeed(PrivateAccess, {
    stables: ["siteName", "slot", "resourceGroup"],

    // Private access exists exactly as long as its app.
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
      if (resourceGroup === undefined || siteName === undefined) return undefined;
      const slot = output?.slot ?? olds?.slot;
      const observed = yield* getAccess(subscriptionId, resourceGroup, siteName, slot);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, siteName, slot, observed);
      if (output !== undefined) return attrs;
      // The singleton always exists and carries no tags: it is ours when the
      // app it configures is.
      return (yield* isSiteOwnedByStack(subscriptionId, resourceGroup, siteName, slot))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Web");
      const { resourceGroup, siteName, slot } = news;
      const desired = toProperties(news);

      // Observe.
      const observed = yield* getAccess(subscriptionId, resourceGroup, siteName, slot);

      // Sync (a synchronous PUT of the whole list), only on drift.
      if (fingerprint(observed?.properties) === fingerprint(desired)) {
        return toAttrs(resourceGroup, siteName, slot, observed);
      }
      const result = yield* putAccess(subscriptionId, resourceGroup, siteName, slot, desired);
      return toAttrs(resourceGroup, siteName, slot, result);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const { resourceGroup, siteName, slot } = output;
      // The singleton cannot be removed: disable it and clear the list.
      yield* ignoreNotFound(
        putAccess(subscriptionId, resourceGroup, siteName, slot, {
          enabled: false,
          virtualNetworks: [],
        }),
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
