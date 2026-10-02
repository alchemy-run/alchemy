import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createEntityName,
  isParentOwned,
  sameName,
  subsetMatches,
} from "./Common.ts";

export interface GatewayLocation {
  /** Canonical name of the location where the gateway runs, e.g. `on-premises-dc1`. */
  name: string;
  /** City or locality. */
  city?: string;
  /** District, state, or province. */
  district?: string;
  /** Country or region. */
  countryOrRegion?: string;
}

export interface GatewayProps {
  /** Resource group of the API Management service. Changing it replaces the gateway. */
  resourceGroup: string;
  /** API Management service that holds the gateway. Changing it replaces the gateway. */
  serviceName: string;
  /**
   * Gateway identifier (1-80 characters, not `managed`). If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the gateway.
   */
  name?: string;
  /** Where the self-hosted gateway runs. */
  locationData: GatewayLocation;
  /** Description of the gateway. */
  description?: string;
}

export interface Gateway extends Resource<
  "Azure.ApiManagement.Gateway",
  GatewayProps,
  {
    /** Gateway identifier. */
    gatewayName: string;
    /** ARM resource ID of the gateway. */
    gatewayId: string;
    /** API Management service that holds the gateway. */
    serviceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
    /** Primary gateway key, used to generate gateway access tokens. */
    primaryKey: Redacted.Redacted<string> | undefined;
    /** Secondary gateway key. */
    secondaryKey: Redacted.Redacted<string> | undefined;
  },
  never,
  Providers
> {}

/**
 * A self-hosted gateway registration in an API Management service. The
 * gateway container runs in your own environment and pulls its
 * configuration from the service. Requires the Developer or Premium tier.
 *
 * @see https://learn.microsoft.com/azure/api-management/self-hosted-gateway-overview
 *
 * ### Registering a Self-Hosted Gateway
 * **Example:** Gateway running in an on-premises data center
 * ```typescript
 * const gateway = yield* Azure.ApiManagement.Gateway("dc1", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   locationData: { name: "dc1", city: "Seattle", countryOrRegion: "US" },
 *   description: "On-premises gateway",
 * });
 * ```
 *
 * @resource
 */
export const Gateway = Resource<Gateway>("Azure.ApiManagement.Gateway");

const getGateway = (
  subscriptionId: string,
  resourceGroupName: string,
  serviceName: string,
  gatewayId: string,
) =>
  orUndefinedIfNotFound(
    apim.GetGateway({
      subscriptionId,
      resourceGroupName,
      serviceName,
      gatewayId,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  serviceName: string,
  name: string,
  gateway: apim.GetGatewayResponse,
  keys: apim.ListGatewayKeysResponse | undefined,
): Gateway["Attributes"] => ({
  gatewayName: name,
  gatewayId: gateway.id ?? "",
  serviceName,
  resourceGroup,
  primaryKey: keys?.primary ? Redacted.make(keys.primary) : undefined,
  secondaryKey: keys?.secondary ? Redacted.make(keys.secondary) : undefined,
});

const listKeys = (
  subscriptionId: string,
  resourceGroupName: string,
  serviceName: string,
  gatewayId: string,
) =>
  orUndefinedIfNotFound(
    apim.ListGatewayKeys({
      subscriptionId,
      resourceGroupName,
      serviceName,
      gatewayId,
    }),
  );

export const GatewayProvider = () =>
  Provider.succeed(Gateway, {
    stables: ["gatewayName", "gatewayId", "serviceName", "resourceGroup"],

    // Gateways live inside a service; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.serviceName, output.serviceName) ||
        (news.name !== undefined && !sameName(news.name, output.gatewayName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const serviceName = output?.serviceName ?? olds?.serviceName;
      if (resourceGroup === undefined || serviceName === undefined) {
        return undefined;
      }
      const name =
        output?.gatewayName ?? olds?.name ?? (yield* createEntityName(id));
      const observed = yield* getGateway(
        subscriptionId,
        resourceGroup,
        serviceName,
        name,
      );
      if (observed === undefined) return undefined;
      const keys = yield* listKeys(
        subscriptionId,
        resourceGroup,
        serviceName,
        name,
      );
      const attrs = toAttrs(resourceGroup, serviceName, name, observed, keys);
      return (yield* isParentOwned(subscriptionId, resourceGroup, serviceName))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.ApiManagement");
      const { resourceGroup, serviceName } = news;
      const name =
        news.name ?? output?.gatewayName ?? (yield* createEntityName(id));
      const desired: apim.GatewayContractProperties = {
        locationData: news.locationData,
        description: news.description,
      };

      // Observe, then create or sync with one upsert when anything differs.
      const observed = yield* getGateway(
        subscriptionId,
        resourceGroup,
        serviceName,
        name,
      );
      const current =
        observed !== undefined && subsetMatches(desired, observed.properties)
          ? observed
          : yield* apim.GatewayCreateOrUpdate({
              subscriptionId,
              resourceGroupName: resourceGroup,
              serviceName,
              gatewayId: name,
              properties: desired,
            });
      const keys = yield* listKeys(
        subscriptionId,
        resourceGroup,
        serviceName,
        name,
      );
      return toAttrs(resourceGroup, serviceName, name, current, keys);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        apim.DeleteGateway({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          serviceName: output.serviceName,
          gatewayId: output.gatewayName,
        }),
      );
      yield* waitUntilGone(
        `API Management gateway ${output.gatewayName}`,
        getGateway(
          subscriptionId,
          output.resourceGroup,
          output.serviceName,
          output.gatewayName,
        ),
        { interval: "2 seconds", times: 15 },
      );
    }),
  });
