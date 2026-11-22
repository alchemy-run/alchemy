import * as cdn from "@distilled.cloud/azure/cdn";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { ensureRegistered, ignoreNotFound, orUndefinedIfNotFound, waitUntilGone } from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import {
  AFD_DELETE_BUDGET,
  changedFields,
  createAfdName,
  profileOwnedByStack,
  ref,
  sameName,
  waitForAfd,
  whileProfileBusy,
} from "./CdnCommon.ts";

export interface AfdLoadBalancingSettings {
  /**
   * Number of recent health-probe samples Front Door considers when it
   * decides whether an origin is healthy. Alchemy sends `4` when you omit
   * `loadBalancingSettings`.
   */
  sampleSize?: number;
  /**
   * Number of samples in the window that must succeed for an origin to
   * count as healthy. Alchemy sends `3` when you omit
   * `loadBalancingSettings`.
   */
  successfulSamplesRequired?: number;
  /**
   * Extra latency, in milliseconds, within which origins count as equally
   * fast; Front Door spreads traffic across all origins in that band.
   * Alchemy sends `50` when you omit `loadBalancingSettings`.
   */
  additionalLatencyInMilliseconds?: number;
}

export interface AfdHealthProbeSettings {
  /** Path probed on each origin, e.g. `/health`. */
  probePath?: string;
  /** Probe request method. `HEAD` costs the origin less than `GET`. */
  probeRequestType?: "NotSet" | "GET" | "HEAD";
  /** Probe protocol. */
  probeProtocol?: "NotSet" | "Http" | "Https";
  /** Seconds between probes from each Front Door edge location. */
  probeIntervalInSeconds?: number;
}

export interface AfdOriginAuthentication {
  /**
   * Identity used to authenticate to origins: the profile's
   * system-assigned identity or one of its user-assigned identities.
   */
  type: "SystemAssignedIdentity" | "UserAssignedIdentity";
  /** ARM ID of the user-assigned identity (for `UserAssignedIdentity`). */
  userAssignedIdentity?: string;
  /** Entra token scope, e.g. `https://storage.azure.com/.default`. */
  scope?: string;
  /** Header the token is sent in. @default "Authorization" */
  tokenDestinationHeader?: "Authorization" | "X-Azure-Authorization";
}

export interface AfdOriginGroupProps {
  /** Resource group of the profile. Changing it replaces the origin group. */
  resourceGroup: string;
  /** Front Door profile that holds the origin group. Changing it replaces the origin group. */
  profile: string;
  /**
   * Origin group name: letters, digits, and hyphens, unique in the
   * profile. If omitted, a unique name is generated from the app, stage,
   * and logical ID. Changing it replaces the origin group.
   */
  name?: string;
  /**
   * Load-balancing settings.
   * @default `{ sampleSize: 4, successfulSamplesRequired: 3, additionalLatencyInMilliseconds: 50 }`
   */
  loadBalancingSettings?: AfdLoadBalancingSettings;
  /**
   * Health-probe settings. Omit to disable health probes; Front Door then
   * treats every enabled origin as healthy.
   * @default no health probes
   */
  healthProbeSettings?: AfdHealthProbeSettings;
  /**
   * Whether requests from a client stick to the same origin (cookie
   * based).
   * @default Azure's default (`Disabled`)
   */
  sessionAffinityState?: "Enabled" | "Disabled";
  /** Minutes to shift traffic gradually to a recovered or new origin. */
  trafficRestorationTimeToHealedOrNewEndpointsInMinutes?: number;
  /**
   * Managed-identity authentication to origins (Premium): Front Door gets
   * an Entra token for `scope` and sends it to every origin in the group.
   * @default no authentication
   */
  authentication?: AfdOriginAuthentication;
}

export interface AfdOriginGroup extends Resource<
  "Azure.Cdn.AfdOriginGroup",
  AfdOriginGroupProps,
  {
    /** Name of the origin group. */
    originGroupName: string;
    /** ARM resource ID of the origin group; reference it from routes. */
    originGroupId: string;
    /** Front Door profile that holds the origin group. */
    profile: string;
    /** Resource group of the profile. */
    resourceGroup: string;
    /** Edge deployment status. */
    deploymentStatus: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A Front Door origin group (`Microsoft.Cdn/profiles/originGroups`): a
 * load-balanced, health-probed pool of origins that routes forward
 * traffic to.
 *
 * Add origins to the group with `Azure.Cdn.AfdOrigin`, then point a route
 * at `originGroupId`. Front Door sends each request to the fastest healthy
 * origin with the lowest `priority`. Origin groups carry no tags; Alchemy
 * treats one as owned when its profile carries this stack's ownership
 * tags.
 *
 * :::caution[Changing `name`, `profile`, or `resourceGroup` replaces the origin group]
 * Alchemy creates a new group with a new `originGroupId`, recreates the
 * origins that reference it, updates the routes, and deletes the old
 * group.
 * :::
 *
 * :::caution[A route needs an origin in the group]
 * Front Door rejects a route whose origin group has no enabled origin.
 * Declare at least one `Azure.Cdn.AfdOrigin` in the group; Alchemy retries
 * the route for up to 10 minutes while the origin deploys.
 * :::
 *
 * @see https://learn.microsoft.com/azure/frontdoor/origin
 *
 * ### Creating an Origin Group
 * **Example:** Origin group with default load balancing
 * ```typescript
 * const profile = yield* Azure.Cdn.Profile("cdn");
 * const origins = yield* Azure.Cdn.AfdOriginGroup("origins", {
 *   profile: profile.profileName,
 * });
 * ```
 *
 * **Example:** Origin group with an HTTPS health probe
 * ```typescript
 * const origins = yield* Azure.Cdn.AfdOriginGroup("origins", {
 *   profile: profile.profileName,
 *   loadBalancingSettings: { sampleSize: 4, successfulSamplesRequired: 3 },
 *   healthProbeSettings: {
 *     probePath: "/",
 *     probeProtocol: "Https",
 *     probeRequestType: "HEAD",
 *     probeIntervalInSeconds: 100,
 *   },
 * });
 * ```
 *
 * ### Health Probes
 * Front Door probes every origin from each edge location and stops
 * sending traffic to an origin that fails. Probe a cheap path. With a
 * single origin, omit `healthProbeSettings` to save the probe traffic.
 *
 * **Example:** Probe a health endpoint every 30 seconds
 * ```typescript
 * const origins = yield* Azure.Cdn.AfdOriginGroup("api", {
 *   profile: profile.profileName,
 *   healthProbeSettings: {
 *     probePath: "/health",
 *     probeProtocol: "Https",
 *     probeRequestType: "GET",
 *     probeIntervalInSeconds: 30,
 *   },
 * });
 * ```
 *
 * ### Load Balancing
 * Origins whose latency is within `additionalLatencyInMilliseconds` of
 * the fastest one share the traffic by `weight`.
 *
 * **Example:** Spread traffic across origins within 200 ms
 * ```typescript
 * const origins = yield* Azure.Cdn.AfdOriginGroup("api", {
 *   profile: profile.profileName,
 *   loadBalancingSettings: {
 *     sampleSize: 4,
 *     successfulSamplesRequired: 2,
 *     additionalLatencyInMilliseconds: 200,
 *   },
 * });
 * ```
 *
 * ### Active-Passive Failover
 * Give the standby origin a higher `priority`. Front Door sends it traffic
 * only when every origin with a lower priority fails its health probe.
 *
 * **Example:** Primary and standby Web Apps
 * ```typescript
 * const primary = yield* Azure.Web.WebApp("ApiEast", { main: "./src/api.ts" });
 * const standby = yield* Azure.Web.WebApp("ApiWest", {
 *   main: "./src/api.ts",
 *   location: "westus2",
 * });
 * const origins = yield* Azure.Cdn.AfdOriginGroup("api", {
 *   profile: profile.profileName,
 *   healthProbeSettings: { probePath: "/health", probeProtocol: "Https" },
 * });
 * yield* Azure.Cdn.AfdOrigin("east", {
 *   profile: profile.profileName,
 *   originGroup: origins.originGroupName,
 *   hostName: primary.defaultHostName,
 *   priority: 1,
 * });
 * yield* Azure.Cdn.AfdOrigin("west", {
 *   profile: profile.profileName,
 *   originGroup: origins.originGroupName,
 *   hostName: standby.defaultHostName,
 *   priority: 2,
 * });
 * ```
 *
 * ### Session Affinity
 * With `sessionAffinityState: "Enabled"`, Front Door sets a cookie and
 * sends a client's later requests to the same origin.
 *
 * **Example:** Sticky sessions
 * ```typescript
 * const origins = yield* Azure.Cdn.AfdOriginGroup("app", {
 *   profile: profile.profileName,
 *   sessionAffinityState: "Enabled",
 * });
 * ```
 *
 * ### Traffic Restoration
 * `trafficRestorationTimeToHealedOrNewEndpointsInMinutes` ramps traffic to
 * a recovered or new origin over that many minutes instead of all at
 * once.
 *
 * **Example:** Ramp a recovered origin over 10 minutes
 * ```typescript
 * const origins = yield* Azure.Cdn.AfdOriginGroup("api", {
 *   profile: profile.profileName,
 *   trafficRestorationTimeToHealedOrNewEndpointsInMinutes: 10,
 * });
 * ```
 *
 * ### Origin Authentication
 * On a Premium profile with a managed identity, Front Door can send an
 * Entra token to the origins. Grant the profile's identity a role on the
 * origin resource.
 *
 * **Example:** Read a private storage account as the profile
 * ```typescript
 * const account = yield* Azure.Storage.StorageAccount("assets");
 * const profile = yield* Azure.Cdn.Profile("cdn", {
 *   sku: "Premium_AzureFrontDoor",
 *   identity: { type: "SystemAssigned" },
 * });
 * yield* Azure.Authorization.RoleAssignment("cdn-reads-assets", {
 *   scope: account.storageAccountId,
 *   roleDefinitionId: Azure.Authorization.BuiltInRole.StorageBlobDataReader,
 *   principalId: profile.principalId.as<string>(),
 *   principalType: "ServicePrincipal",
 * });
 * const origins = yield* Azure.Cdn.AfdOriginGroup("assets", {
 *   profile: profile.profileName,
 *   authentication: {
 *     type: "SystemAssignedIdentity",
 *     scope: "https://storage.azure.com/.default",
 *   },
 * });
 * ```
 *
 * ### Routing to the Group
 * **Example:** Send an endpoint's traffic to the group
 * ```typescript
 * const endpoint = yield* Azure.Cdn.AfdEndpoint("web", {
 *   profile: profile.profileName,
 * });
 * yield* Azure.Cdn.Route("default", {
 *   profile: profile.profileName,
 *   endpoint: endpoint.endpointName,
 *   originGroupId: origins.originGroupId,
 * });
 * ```
 *
 * @resource
 */
export const AfdOriginGroup = GroupedResource<AfdOriginGroup>("Azure.Cdn.AfdOriginGroup");

const createOriginGroupName = (id: string) => createAfdName(id, 50);

const getOriginGroup = (
  subscriptionId: string,
  resourceGroupName: string,
  profileName: string,
  originGroupName: string,
) =>
  orUndefinedIfNotFound(
    cdn.GetAFDOriginGroup({
      subscriptionId,
      resourceGroupName,
      profileName,
      originGroupName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  profile: string,
  name: string,
  group: cdn.GetAFDOriginGroupResponse,
): AfdOriginGroup["Attributes"] => ({
  originGroupName: name,
  originGroupId: group.id ?? "",
  profile,
  resourceGroup,
  deploymentStatus: group.properties?.deploymentStatus,
});

const desiredProperties = (news: AfdOriginGroupProps) => ({
  loadBalancingSettings: news.loadBalancingSettings ?? {
    sampleSize: 4,
    successfulSamplesRequired: 3,
    additionalLatencyInMilliseconds: 50,
  },
  healthProbeSettings: news.healthProbeSettings,
  sessionAffinityState: news.sessionAffinityState,
  trafficRestorationTimeToHealedOrNewEndpointsInMinutes:
    news.trafficRestorationTimeToHealedOrNewEndpointsInMinutes,
  authentication:
    news.authentication === undefined
      ? undefined
      : {
          ...news.authentication,
          userAssignedIdentity: ref(news.authentication.userAssignedIdentity),
        },
});

export const AfdOriginGroupProvider = () =>
  Provider.succeed(AfdOriginGroup, {
    stables: ["originGroupName", "originGroupId", "profile", "resourceGroup"],

    // Origin groups are deleted with their profile.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.profile, output.profile) ||
        (news.name !== undefined && !sameName(news.name, output.originGroupName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const profile = output?.profile ?? olds?.profile;
      if (resourceGroup === undefined || profile === undefined) return undefined;
      const name = output?.originGroupName ?? olds?.name ?? (yield* createOriginGroupName(id));
      const observed = yield* getOriginGroup(subscriptionId, resourceGroup, profile, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, profile, name, observed);
      return (yield* profileOwnedByStack(subscriptionId, resourceGroup, profile))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Cdn");
      const { resourceGroup, profile } = news;
      const name = news.name ?? output?.originGroupName ?? (yield* createOriginGroupName(id));
      const properties = desiredProperties(news);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        profileName: profile,
        originGroupName: name,
      };
      const get = getOriginGroup(subscriptionId, resourceGroup, profile, name);
      const label = `Front Door origin group ${name}`;

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* cdn
          .CreateAFDOriginGroup({ ...where, properties })
          .pipe(Effect.retry(whileProfileBusy));
      }
      observed = yield* waitForAfd(label, get, (g) => g.properties?.provisioningState);

      // Sync mutable settings against observed state.
      const changed = changedFields(properties, observed.properties);
      if (Object.keys(changed).length > 0) {
        yield* cdn
          .UpdateAFDOriginGroup({ ...where, properties: changed })
          .pipe(Effect.retry(whileProfileBusy));
        observed = yield* waitForAfd(label, get, (g) => g.properties?.provisioningState);
      }

      return toAttrs(resourceGroup, profile, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        cdn
          .DeleteAFDOriginGroup({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            profileName: output.profile,
            originGroupName: output.originGroupName,
          })
          .pipe(Effect.retry(whileProfileBusy)),
      );
      yield* waitUntilGone(
        `Front Door origin group ${output.originGroupName}`,
        getOriginGroup(
          subscriptionId,
          output.resourceGroup,
          output.profile,
          output.originGroupName,
        ),
        AFD_DELETE_BUDGET,
      );
    }),
  });
