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
  tagsDiffer,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  desiredProfileTags,
  hasAnyProfileMarker,
  ownsProfile,
  userProfileTags,
} from "./Ownership.ts";

/** How Traffic Manager picks the endpoint returned in a DNS response. */
export type TrafficRoutingMethod =
  | "Performance"
  | "Priority"
  | "Weighted"
  | "Geographic"
  | "MultiValue"
  | "Subnet";

/** Endpoint health-probe settings of a Traffic Manager profile. */
export interface TrafficManagerMonitorConfig {
  /**
   * Protocol used to probe endpoint health.
   * @default "HTTP"
   */
  protocol?: "HTTP" | "HTTPS" | "TCP";
  /**
   * TCP port used to probe endpoint health.
   * @default 80
   */
  port?: number;
  /**
   * Path probed for HTTP/HTTPS health checks. Must be omitted for TCP.
   * @default "/"
   */
  path?: string;
  /**
   * Seconds between health probes: `10` (fast probing, billed extra) or
   * `30`.
   * @default 30
   */
  intervalInSeconds?: number;
  /**
   * Seconds a probe may take before it counts as failed (5-10 for a 30s
   * interval, 5-9 for a 10s interval).
   * @default 10
   */
  timeoutInSeconds?: number;
  /**
   * Consecutive failed probes tolerated before an endpoint is marked
   * degraded (0-9).
   * @default 3
   */
  toleratedNumberOfFailures?: number;
  /** Custom headers sent with each health probe. */
  customHeaders?: { name: string; value: string }[];
  /** HTTP status code ranges that count as healthy, e.g. `[{ min: 200, max: 299 }]`. */
  expectedStatusCodeRanges?: { min: number; max: number }[];
}

export interface ProfileProps {
  /**
   * Resource group the profile is created in. Changing it replaces the
   * profile.
   */
  resourceGroup: string;
  /**
   * Name of the profile, 1-63 characters of letters, digits, `-`, and `.`.
   * If omitted, a unique lowercase name is generated from the app, stage,
   * and logical ID. Changing it replaces the profile.
   */
  name?: string;
  /**
   * DNS label of the profile: the profile answers at
   * `<relativeName>.trafficmanager.net`. Must be globally unique. Changing
   * it replaces the profile.
   * @default the profile name, lowercased
   */
  relativeName?: string;
  /** How Traffic Manager routes DNS queries to the profile's endpoints. */
  trafficRoutingMethod: TrafficRoutingMethod;
  /**
   * DNS time-to-live in seconds returned to resolvers.
   * @default 60
   */
  ttl?: number;
  /**
   * Endpoint health-probe settings. Unset fields keep Azure's current
   * values (or the documented defaults on create).
   */
  monitorConfig?: TrafficManagerMonitorConfig;
  /**
   * Whether the profile answers DNS queries.
   * @default "Enabled"
   */
  profileStatus?: "Enabled" | "Disabled";
  /**
   * Whether Traffic View (billed per data point) is enabled.
   * @default "Disabled"
   */
  trafficViewEnrollmentStatus?: "Enabled" | "Disabled";
  /** DNS record types the profile's endpoints may use. */
  allowedEndpointRecordTypes?: (
    | "DomainName"
    | "IPv4Address"
    | "IPv6Address"
    | "Any"
  )[];
  /**
   * Maximum number of endpoints returned per DNS response (1-8). Only valid
   * with `trafficRoutingMethod: "MultiValue"`.
   */
  maxReturn?: number;
  /**
   * User tags. Traffic Manager drops tag keys containing `:`, so Alchemy's
   * ownership markers (`alchemy_stack`, `alchemy_stage`, `alchemy_id`) are
   * merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Profile extends Resource<
  "Azure.TrafficManager.Profile",
  ProfileProps,
  {
    /** Name of the profile. */
    profileName: string;
    /** Resource group that holds the profile. */
    resourceGroup: string;
    /** ARM resource ID of the profile. */
    profileId: string;
    /** DNS label of the profile. */
    relativeName: string;
    /** Fully-qualified DNS name, `<relativeName>.trafficmanager.net`. */
    fqdn: string;
    /** Traffic routing method in effect. */
    trafficRoutingMethod: string;
    /** DNS time-to-live in seconds. */
    ttl: number;
    /** Whether the profile is enabled. */
    profileStatus: string;
    /** Profile-level health status (e.g. `Online`, `Degraded`, `Inactive`). */
    monitorStatus: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Traffic Manager profile — global DNS-based load balancing that
 * answers `<relativeName>.trafficmanager.net` with the healthiest endpoint
 * according to its routing method (priority failover, weighted,
 * performance, geographic, multi-value, or subnet). Add endpoints with
 * `Azure.TrafficManager.Endpoint`.
 *
 * @see https://learn.microsoft.com/azure/traffic-manager/traffic-manager-overview
 *
 * ### Creating a Profile
 * **Example:** Priority failover profile with an HTTPS health probe
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("dns");
 * const profile = yield* Azure.TrafficManager.Profile("global", {
 *   resourceGroup: group.resourceGroupName,
 *   trafficRoutingMethod: "Priority",
 *   monitorConfig: { protocol: "HTTPS", port: 443, path: "/health" },
 * });
 * // profile.fqdn === "<relativeName>.trafficmanager.net"
 * ```
 *
 * **Example:** Weighted profile with a custom DNS label
 * ```typescript
 * const profile = yield* Azure.TrafficManager.Profile("canary", {
 *   resourceGroup: group.resourceGroupName,
 *   relativeName: "my-app-canary",
 *   trafficRoutingMethod: "Weighted",
 *   ttl: 30,
 * });
 * ```
 *
 * ### Adding Endpoints
 * **Example:** Fail over between two external hosts
 * ```typescript
 * yield* Azure.TrafficManager.Endpoint("primary", {
 *   resourceGroup: group.resourceGroupName,
 *   profile: profile.profileName,
 *   endpointType: "ExternalEndpoints",
 *   target: "primary.example.com",
 *   priority: 1,
 * });
 * ```
 *
 * @resource
 */
export const Profile = Resource<Profile>("Azure.TrafficManager.Profile");

type ObservedProfile = trafficmanager.GetProfileResponse;

const physicalName = (id: string) =>
  createPhysicalName({ id, maxLength: 63, lowercase: true });

const getProfile = (
  subscriptionId: string,
  resourceGroupName: string,
  profileName: string,
) =>
  orUndefinedIfNotFound(
    trafficmanager.GetProfile({
      subscriptionId,
      resourceGroupName,
      profileName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  profile: ObservedProfile,
): Profile["Attributes"] => ({
  profileName: name,
  resourceGroup,
  profileId: profile.id ?? "",
  relativeName: profile.properties?.dnsConfig?.relativeName ?? "",
  fqdn: profile.properties?.dnsConfig?.fqdn ?? "",
  trafficRoutingMethod: profile.properties?.trafficRoutingMethod ?? "",
  ttl: profile.properties?.dnsConfig?.ttl ?? 0,
  profileStatus: profile.properties?.profileStatus ?? "",
  monitorStatus: profile.properties?.monitorConfig?.profileMonitorStatus,
  tags: userProfileTags(profile.tags),
});

const MONITOR_DEFAULTS = {
  protocol: "HTTP",
  port: 80,
  path: "/",
  intervalInSeconds: 30,
  timeoutInSeconds: 10,
  toleratedNumberOfFailures: 3,
} as const;

const sameJson = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

/** Monitor fields the user set that differ from the observed config. */
const monitorDrifts = (
  observed: trafficmanager.MonitorConfig | undefined,
  desired: TrafficManagerMonitorConfig,
) =>
  (Object.keys(desired) as (keyof TrafficManagerMonitorConfig)[]).some(
    (key) =>
      desired[key] !== undefined &&
      !sameJson(observed?.[key] ?? undefined, desired[key]),
  );

/** Observed monitor config without the read-only status, merged with desired. */
const mergedMonitor = (
  observed: trafficmanager.MonitorConfig | undefined,
  desired: TrafficManagerMonitorConfig,
): trafficmanager.MonitorConfig => {
  const { profileMonitorStatus: _, ...rest } = observed ?? {};
  const merged: trafficmanager.MonitorConfig = { ...rest };
  for (const [key, value] of Object.entries(desired)) {
    if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
  }
  // TCP probes reject a path.
  if (merged.protocol === "TCP") delete merged.path;
  return merged;
};

export const ProfileProvider = () =>
  Provider.succeed(Profile, {
    stables: [
      "profileName",
      "resourceGroup",
      "profileId",
      "relativeName",
      "fqdn",
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
        return hasAnyProfileMarker(profile.tags) &&
          group !== undefined &&
          profile.name !== undefined
          ? [toAttrs(group, profile.name, profile)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const name = news.name ?? output.profileName;
      const relativeName = news.relativeName ?? name.toLowerCase();
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        name.toLowerCase() !== output.profileName.toLowerCase() ||
        relativeName.toLowerCase() !== output.relativeName.toLowerCase()
      ) {
        // A pinned name that stays the same can only be replaced by
        // deleting the old profile first.
        const sameName =
          news.name !== undefined &&
          news.resourceGroup.toLowerCase() ===
            output.resourceGroup.toLowerCase() &&
          name.toLowerCase() === output.profileName.toLowerCase();
        return { action: "replace", deleteFirst: sameName } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.profileName ?? olds?.name ?? (yield* physicalName(id));
      const observed = yield* getProfile(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* ownsProfile(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Network");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.profileName ?? (yield* physicalName(id));
      const relativeName = news.relativeName ?? name.toLowerCase();
      const ttl = news.ttl ?? 60;
      const profileStatus = news.profileStatus ?? "Enabled";
      const monitor = news.monitorConfig ?? {};
      const tags = yield* desiredProfileTags(id, news.tags);
      const request = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        profileName: name,
      };

      // Observe.
      let observed = yield* getProfile(subscriptionId, resourceGroup, name);

      // Ensure: create without endpoints; endpoints are their own resources.
      if (observed === undefined) {
        observed = yield* trafficmanager.ProfilesCreateOrUpdate({
          ...request,
          location: "global",
          tags,
          properties: {
            profileStatus,
            trafficRoutingMethod: news.trafficRoutingMethod,
            dnsConfig: { relativeName, ttl },
            monitorConfig: mergedMonitor(MONITOR_DEFAULTS, monitor),
            trafficViewEnrollmentStatus: news.trafficViewEnrollmentStatus,
            allowedEndpointRecordTypes: news.allowedEndpointRecordTypes,
            maxReturn: news.maxReturn,
          },
        });
      }

      // Sync: PATCH only the observed deltas. A PUT would also replace the
      // endpoint list owned by `Azure.TrafficManager.Endpoint`.
      const props = observed.properties;
      const patch: trafficmanager.ProfilePropertiesInput = {};
      if (props?.trafficRoutingMethod !== news.trafficRoutingMethod) {
        patch.trafficRoutingMethod = news.trafficRoutingMethod;
      }
      if (props?.profileStatus !== profileStatus) {
        patch.profileStatus = profileStatus;
      }
      if (props?.dnsConfig?.ttl !== ttl) {
        patch.dnsConfig = { ttl };
      }
      if (monitorDrifts(props?.monitorConfig, monitor)) {
        patch.monitorConfig = mergedMonitor(props?.monitorConfig, monitor);
      }
      if (
        news.trafficViewEnrollmentStatus !== undefined &&
        props?.trafficViewEnrollmentStatus !== news.trafficViewEnrollmentStatus
      ) {
        patch.trafficViewEnrollmentStatus = news.trafficViewEnrollmentStatus;
      }
      if (
        news.allowedEndpointRecordTypes !== undefined &&
        !sameJson(
          props?.allowedEndpointRecordTypes ?? [],
          news.allowedEndpointRecordTypes,
        )
      ) {
        patch.allowedEndpointRecordTypes = news.allowedEndpointRecordTypes;
      }
      if (news.maxReturn !== undefined && props?.maxReturn !== news.maxReturn) {
        patch.maxReturn = news.maxReturn;
      }
      const retag = tagsDiffer(observed.tags, tags);
      if (Object.keys(patch).length > 0 || retag) {
        observed = yield* trafficmanager.UpdateProfile({
          ...request,
          ...(retag ? { tags } : {}),
          ...(Object.keys(patch).length > 0 ? { properties: patch } : {}),
        });
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        trafficmanager.DeleteProfile({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          profileName: output.profileName,
        }),
      );
      yield* waitUntilGone(
        `traffic manager profile ${output.profileName}`,
        getProfile(subscriptionId, output.resourceGroup, output.profileName),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
