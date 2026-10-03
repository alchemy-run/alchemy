import * as trafficmanager from "@distilled.cloud/azure/trafficmanager";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { hasAnyProfileMarker, ownedByStack } from "./Ownership.ts";

/** Kind of Traffic Manager endpoint (part of its ARM resource path). */
export type TrafficManagerEndpointType =
  | "AzureEndpoints"
  | "ExternalEndpoints"
  | "NestedEndpoints";

export interface EndpointProps {
  /**
   * Resource group of the parent profile. Changing it replaces the
   * endpoint.
   */
  resourceGroup: string;
  /** Name of the parent Traffic Manager profile. Changing it replaces the endpoint. */
  profile: string;
  /**
   * Endpoint kind: `AzureEndpoints` (an Azure resource such as a public IP
   * with a DNS label or an App Service), `ExternalEndpoints` (any FQDN or
   * IP), or `NestedEndpoints` (another Traffic Manager profile). Changing
   * it replaces the endpoint.
   */
  endpointType: TrafficManagerEndpointType;
  /**
   * Name of the endpoint. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the endpoint.
   */
  name?: string;
  /**
   * FQDN or IP address returned in DNS responses. Required for
   * `ExternalEndpoints`; derived by Azure for the other types.
   */
  target?: string;
  /**
   * ARM resource ID of the target: a public IP / App Service / Cloud
   * Service for `AzureEndpoints`, a child profile for `NestedEndpoints`.
   */
  targetResourceId?: string;
  /**
   * Whether the endpoint is probed and included in routing.
   * @default "Enabled"
   */
  endpointStatus?: "Enabled" | "Disabled";
  /** Weight (1-1000) under `Weighted` routing. */
  weight?: number;
  /**
   * Priority (1-1000, lower wins, unique per profile) under `Priority`
   * routing. Azure assigns one if omitted.
   */
  priority?: number;
  /**
   * Azure region of an external or nested endpoint, required under
   * `Performance` routing (e.g. `"East US"`).
   */
  endpointLocation?: string;
  /** Minimum healthy endpoints in the child profile (`NestedEndpoints` only). */
  minChildEndpoints?: number;
  /** Minimum healthy IPv4 endpoints in the child profile (`NestedEndpoints` only). */
  minChildEndpointsIPv4?: number;
  /** Minimum healthy IPv6 endpoints in the child profile (`NestedEndpoints` only). */
  minChildEndpointsIPv6?: number;
  /** Countries/regions mapped to the endpoint under `Geographic` routing (e.g. `["US", "GEO-EU"]`). */
  geoMapping?: string[];
  /** Client subnets mapped to the endpoint under `Subnet` routing. */
  subnets?: { first?: string; last?: string; scope?: number }[];
  /** Custom headers sent with this endpoint's health probes. */
  customHeaders?: { name: string; value: string }[];
  /**
   * When `Enabled`, health probing is skipped and the endpoint is always
   * included in routing.
   * @default "Disabled"
   */
  alwaysServe?: "Enabled" | "Disabled";
}

export interface Endpoint extends Resource<
  "Azure.TrafficManager.Endpoint",
  EndpointProps,
  {
    /** Name of the endpoint. */
    endpointName: string;
    /** Name of the parent profile. */
    profileName: string;
    /** Resource group of the parent profile. */
    resourceGroup: string;
    /** Endpoint kind. */
    endpointType: TrafficManagerEndpointType;
    /** ARM resource ID of the endpoint. */
    endpointId: string;
    /** FQDN or IP returned in DNS responses. */
    target: string | undefined;
    /** ARM resource ID of the Azure or nested target. */
    targetResourceId: string | undefined;
    /** Whether the endpoint is enabled. */
    endpointStatus: string | undefined;
    /** Priority under `Priority` routing. */
    priority: number | undefined;
    /** Weight under `Weighted` routing. */
    weight: number | undefined;
    /** Health status reported by the probes (e.g. `Online`, `Degraded`). */
    endpointMonitorStatus: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An endpoint of an Azure Traffic Manager profile: an external FQDN/IP, an
 * Azure resource (public IP with a DNS label, App Service, ...), or a
 * nested profile that DNS queries can be routed to.
 *
 * Endpoints carry no tags. Alchemy treats one as owned when its parent
 * profile carries this stack's and stage's ownership markers. Deleting the
 * profile deletes its endpoints.
 *
 * @see https://learn.microsoft.com/azure/traffic-manager/traffic-manager-endpoint-types
 *
 * ### External Endpoints
 * **Example:** Priority failover between two hosts
 * ```typescript
 * const profile = yield* Azure.TrafficManager.Profile("global", {
 *   resourceGroup: group.resourceGroupName,
 *   trafficRoutingMethod: "Priority",
 * });
 * yield* Azure.TrafficManager.Endpoint("primary", {
 *   resourceGroup: group.resourceGroupName,
 *   profile: profile.profileName,
 *   endpointType: "ExternalEndpoints",
 *   target: "primary.example.com",
 *   priority: 1,
 * });
 * yield* Azure.TrafficManager.Endpoint("secondary", {
 *   resourceGroup: group.resourceGroupName,
 *   profile: profile.profileName,
 *   endpointType: "ExternalEndpoints",
 *   target: "secondary.example.com",
 *   priority: 2,
 * });
 * ```
 *
 * ### Azure Endpoints
 * **Example:** Route to a public IP with a DNS label
 * ```typescript
 * yield* Azure.TrafficManager.Endpoint("eastus", {
 *   resourceGroup: group.resourceGroupName,
 *   profile: profile.profileName,
 *   endpointType: "AzureEndpoints",
 *   targetResourceId: publicIp.publicIpAddressId,
 *   weight: 100,
 * });
 * ```
 *
 * ### Nested Profiles
 * **Example:** Use a child profile as an endpoint
 * ```typescript
 * yield* Azure.TrafficManager.Endpoint("europe", {
 *   resourceGroup: group.resourceGroupName,
 *   profile: parent.profileName,
 *   endpointType: "NestedEndpoints",
 *   targetResourceId: child.profileId,
 *   endpointLocation: "West Europe",
 *   minChildEndpoints: 1,
 * });
 * ```
 *
 * @resource
 */
export const Endpoint = Resource<Endpoint>("Azure.TrafficManager.Endpoint");

type ObservedEndpoint = trafficmanager.GetEndpointResponse;

const physicalName = (id: string) => createPhysicalName({ id, maxLength: 63 });

const getEndpoint = (
  subscriptionId: string,
  resourceGroupName: string,
  profileName: string,
  endpointType: TrafficManagerEndpointType,
  endpointName: string,
) =>
  orUndefinedIfNotFound(
    trafficmanager.GetEndpoint({
      subscriptionId,
      resourceGroupName,
      profileName,
      endpointType,
      endpointName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  profileName: string,
  endpointType: TrafficManagerEndpointType,
  name: string,
  endpoint: ObservedEndpoint,
): Endpoint["Attributes"] => ({
  endpointName: name,
  profileName,
  resourceGroup,
  endpointType,
  endpointId: endpoint.id ?? "",
  target: endpoint.properties?.target,
  targetResourceId: endpoint.properties?.targetResourceId,
  endpointStatus: endpoint.properties?.endpointStatus,
  priority: endpoint.properties?.priority,
  weight: endpoint.properties?.weight,
  endpointMonitorStatus: endpoint.properties?.endpointMonitorStatus,
});

/** `Microsoft.Network/trafficManagerProfiles/externalEndpoints` → `ExternalEndpoints`. */
const endpointTypeOf = (
  type: string | undefined,
): TrafficManagerEndpointType | undefined => {
  const last = type?.split("/").pop()?.toLowerCase();
  return last === "azureendpoints"
    ? "AzureEndpoints"
    : last === "externalendpoints"
      ? "ExternalEndpoints"
      : last === "nestedendpoints"
        ? "NestedEndpoints"
        : undefined;
};

const sameJson = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

/** Fields the user set that differ from the observed endpoint. */
const drifts = (
  observed: trafficmanager.EndpointProperties | undefined,
  desired: trafficmanager.EndpointProperties,
) =>
  (Object.keys(desired) as (keyof trafficmanager.EndpointProperties)[]).some(
    (key) => {
      const want = desired[key];
      if (want === undefined) return false;
      const have = observed?.[key];
      return typeof want === "string" && typeof have === "string"
        ? want.toLowerCase() !== have.toLowerCase()
        : !sameJson(have, want);
    },
  );

/** The parent profile carries this stack's and stage's ownership markers. */
const parentOwned = (
  subscriptionId: string,
  resourceGroupName: string,
  profileName: string,
) =>
  Effect.gen(function* () {
    const profile = yield* orUndefinedIfNotFound(
      trafficmanager.GetProfile({
        subscriptionId,
        resourceGroupName,
        profileName,
      }),
    );
    return profile !== undefined && (yield* ownedByStack(profile.tags));
  });

export const EndpointProvider = () =>
  Provider.succeed(Endpoint, {
    stables: [
      "endpointName",
      "profileName",
      "resourceGroup",
      "endpointType",
      "endpointId",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* trafficmanager
        .ListProfileBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListProfileBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((profile) => {
        const group = resourceGroupOf(profile.id);
        if (
          !hasAnyProfileMarker(profile.tags) ||
          group === undefined ||
          profile.name === undefined
        ) {
          return [];
        }
        return (profile.properties?.endpoints ?? []).flatMap((endpoint) => {
          const type = endpointTypeOf(endpoint.type);
          return type !== undefined && endpoint.name !== undefined
            ? [toAttrs(group, profile.name!, type, endpoint.name, endpoint)]
            : [];
        });
      });
    }),

    diff: Effect.fn(function* ({ id, news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const name =
        news.name ?? output.endpointName ?? (yield* physicalName(id));
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.profile.toLowerCase() !== output.profileName.toLowerCase() ||
        news.endpointType !== output.endpointType ||
        name.toLowerCase() !== output.endpointName.toLowerCase()
      ) {
        // Priorities are unique per profile, so a replacement inside the
        // same profile frees the old endpoint first.
        const sameProfile =
          news.resourceGroup.toLowerCase() ===
            output.resourceGroup.toLowerCase() &&
          news.profile.toLowerCase() === output.profileName.toLowerCase();
        return { action: "replace", deleteFirst: sameProfile } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const profileName = output?.profileName ?? olds?.profile;
      const endpointType = output?.endpointType ?? olds?.endpointType;
      if (
        resourceGroup === undefined ||
        profileName === undefined ||
        endpointType === undefined
      ) {
        return undefined;
      }
      const name =
        output?.endpointName ?? olds?.name ?? (yield* physicalName(id));
      const observed = yield* getEndpoint(
        subscriptionId,
        resourceGroup,
        profileName,
        endpointType,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        profileName,
        endpointType,
        name,
        observed,
      );
      return (yield* parentOwned(subscriptionId, resourceGroup, profileName))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Network");
      const resourceGroup = news.resourceGroup;
      const profileName = news.profile;
      const endpointType = news.endpointType;
      const name =
        news.name ?? output?.endpointName ?? (yield* physicalName(id));
      const desired: trafficmanager.EndpointProperties = {
        target: news.target,
        targetResourceId: news.targetResourceId,
        endpointStatus: news.endpointStatus ?? "Enabled",
        weight: news.weight,
        priority: news.priority,
        endpointLocation: news.endpointLocation,
        minChildEndpoints: news.minChildEndpoints,
        minChildEndpointsIPv4: news.minChildEndpointsIPv4,
        minChildEndpointsIPv6: news.minChildEndpointsIPv6,
        geoMapping: news.geoMapping,
        subnets: news.subnets,
        customHeaders: news.customHeaders,
        alwaysServe: news.alwaysServe,
      };

      // Observe.
      let observed: ObservedEndpoint | undefined = yield* getEndpoint(
        subscriptionId,
        resourceGroup,
        profileName,
        endpointType,
        name,
      );

      // Ensure + sync: the endpoint PUT is a synchronous full upsert of
      // this endpoint only. Compare the fields the user set against the
      // observed endpoint and write only on drift.
      if (observed === undefined || drifts(observed.properties, desired)) {
        observed = yield* trafficmanager.EndpointsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          profileName,
          endpointType,
          endpointName: name,
          properties: desired,
        });
      }

      return toAttrs(resourceGroup, profileName, endpointType, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        trafficmanager.DeleteEndpoint({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          profileName: output.profileName,
          endpointType: output.endpointType,
          endpointName: output.endpointName,
        }),
      );
      yield* waitUntilGone(
        `traffic manager endpoint ${output.endpointName}`,
        getEndpoint(
          subscriptionId,
          output.resourceGroup,
          output.profileName,
          output.endpointType,
          output.endpointName,
        ),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.TrafficManager.Profile",
      ],
    },
  });
