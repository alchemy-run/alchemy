import * as cdn from "@distilled.cloud/azure/cdn";
import * as Effect from "effect/Effect";
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
  /** Number of samples considered for load-balancing decisions. */
  sampleSize?: number;
  /** Number of samples in the window that must succeed. */
  successfulSamplesRequired?: number;
  /** Extra latency (ms) within which origins count as equally fast. */
  additionalLatencyInMilliseconds?: number;
}

export interface AfdHealthProbeSettings {
  /** Path probed on each origin, e.g. `/health`. */
  probePath?: string;
  /** Probe request method. */
  probeRequestType?: "NotSet" | "GET" | "HEAD";
  /** Probe protocol. */
  probeProtocol?: "NotSet" | "Http" | "Https";
  /** Seconds between probes. */
  probeIntervalInSeconds?: number;
}

export interface AfdOriginAuthentication {
  /** Identity used to authenticate to origins. */
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
  /** Health-probe settings. Omit to disable health probes. */
  healthProbeSettings?: AfdHealthProbeSettings;
  /** Whether requests from a client stick to the same origin. */
  sessionAffinityState?: "Enabled" | "Disabled";
  /** Minutes to shift traffic gradually to a recovered or new origin. */
  trafficRestorationTimeToHealedOrNewEndpointsInMinutes?: number;
  /** Managed-identity authentication to origins (Premium). */
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
 * A Front Door origin group — a load-balanced, health-probed pool of
 * origins that routes forward traffic to.
 *
 * Origin groups carry no tags; Alchemy treats one as owned when its
 * profile carries this stack's ownership tags.
 *
 * @see https://learn.microsoft.com/azure/frontdoor/origin
 *
 * ### Creating an Origin Group
 * **Example:** Origin group with an HTTPS health probe
 * ```typescript
 * const origins = yield* Azure.Cdn.AfdOriginGroup("origins", {
 *   resourceGroup: group.resourceGroupName,
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
 * @resource
 */
export const AfdOriginGroup = Resource<AfdOriginGroup>(
  "Azure.Cdn.AfdOriginGroup",
);

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
        (news.name !== undefined &&
          !sameName(news.name, output.originGroupName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const profile = output?.profile ?? olds?.profile;
      if (resourceGroup === undefined || profile === undefined)
        return undefined;
      const name =
        output?.originGroupName ??
        olds?.name ??
        (yield* createOriginGroupName(id));
      const observed = yield* getOriginGroup(
        subscriptionId,
        resourceGroup,
        profile,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, profile, name, observed);
      return (yield* profileOwnedByStack(
        subscriptionId,
        resourceGroup,
        profile,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Cdn");
      const { resourceGroup, profile } = news;
      const name =
        news.name ??
        output?.originGroupName ??
        (yield* createOriginGroupName(id));
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
      observed = yield* waitForAfd(
        label,
        get,
        (g) => g.properties?.provisioningState,
      );

      // Sync mutable settings against observed state.
      const changed = changedFields(properties, observed.properties);
      if (Object.keys(changed).length > 0) {
        yield* cdn
          .UpdateAFDOriginGroup({ ...where, properties: changed })
          .pipe(Effect.retry(whileProfileBusy));
        observed = yield* waitForAfd(
          label,
          get,
          (g) => g.properties?.provisioningState,
        );
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
