import * as desktopvirtualization from "@distilled.cloud/azure/desktopvirtualization";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { createAvdName, deltaOf } from "./Common.ts";

export type HostPoolType = "Pooled" | "Personal" | "BYODesktop";

export type HostPoolLoadBalancerType =
  | "BreadthFirst"
  | "DepthFirst"
  | "Persistent"
  | "MultiplePersistent";

export type HostPoolPreferredAppGroupType =
  | "Desktop"
  | "RailApplications"
  | "None";

export type HostPoolPublicNetworkAccess =
  | "Enabled"
  | "Disabled"
  | "EnabledForSessionHostsOnly"
  | "EnabledForClientsOnly";

/** A two-hour maintenance window for session host agent updates. */
export interface HostPoolMaintenanceWindow {
  /** Hour of the day (0-23) the window starts. */
  hour: number;
  /** Day of the week the window falls on. */
  dayOfWeek:
    | "Monday"
    | "Tuesday"
    | "Wednesday"
    | "Thursday"
    | "Friday"
    | "Saturday"
    | "Sunday";
}

/** How session host agents and stack components are updated. */
export interface HostPoolAgentUpdate {
  /** `Default` lets Azure update at any time; `Scheduled` uses the windows. */
  type: "Default" | "Scheduled";
  /** Interpret the windows in each session host's local time. */
  useSessionHostLocalTime?: boolean;
  /** Time zone of the windows when `useSessionHostLocalTime` is false. */
  maintenanceWindowTimeZone?: string;
  /** Maintenance windows (up to two). */
  maintenanceWindows?: HostPoolMaintenanceWindow[];
}

export interface HostPoolProps {
  /** Resource group of the host pool. Changing it replaces the host pool. */
  resourceGroup: string;
  /**
   * Host pool name, 3-64 letters, digits, `@`, `.`, `-`, `_`, or spaces. If
   * omitted, a unique name is generated from the app, stage, and logical ID.
   * Changing it replaces the host pool.
   */
  name?: string;
  /**
   * Azure location that stores the host pool's metadata. Must be an Azure
   * Virtual Desktop metadata region (e.g. `eastus`, `westeurope`). Changing
   * it replaces the host pool.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * `Pooled` shares session hosts between users; `Personal` assigns each
   * user a dedicated session host. Changing it replaces the host pool.
   */
  hostPoolType: HostPoolType;
  /**
   * How users of a `Personal` host pool get their session host. Changing it
   * replaces the host pool.
   */
  personalDesktopAssignmentType?: "Automatic" | "Direct";
  /**
   * How new sessions are distributed. `Personal` host pools must use
   * `Persistent`.
   */
  loadBalancerType: HostPoolLoadBalancerType;
  /**
   * Application group type users see by default.
   * @default "Desktop"
   */
  preferredAppGroupType?: HostPoolPreferredAppGroupType;
  /** Maximum number of sessions per session host (pooled host pools). */
  maxSessionLimit?: number;
  /** Display name shown to users. */
  friendlyName?: string;
  /** Description of the host pool. */
  description?: string;
  /** RDP properties applied to every connection, e.g. `audiomode:i:0;`. */
  customRdpProperty?: string;
  /** Mark the host pool as a validation environment that gets updates first. */
  validationEnvironment?: boolean;
  /**
   * Start deallocated session hosts when a user connects. Needs the
   * `Desktop Virtualization Power On Contributor` role for the Azure
   * Virtual Desktop service principal.
   */
  startVMOnConnect?: boolean;
  /** Which traffic may use the public network. */
  publicNetworkAccess?: HostPoolPublicNetworkAccess;
  /** JSON template describing session hosts added to the pool. */
  vmTemplate?: string;
  /** Agent update schedule for session hosts. */
  agentUpdate?: HostPoolAgentUpdate;
  /**
   * Lifetime, in hours (1-720), of the registration token session hosts use
   * to join the pool. When set, a token is issued if none is valid and
   * exposed as `registrationToken`; an existing valid token is reused.
   */
  registrationTokenTtlHours?: number;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface HostPool extends Resource<
  "Azure.DesktopVirtualization.HostPool",
  HostPoolProps,
  {
    /** Name of the host pool. */
    hostPoolName: string;
    /** ARM resource ID of the host pool. */
    hostPoolId: string;
    /** Resource group of the host pool. */
    resourceGroup: string;
    /** Metadata location of the host pool. */
    location: string;
    /** Host pool type. */
    hostPoolType: string;
    /** Personal desktop assignment type (personal host pools). */
    personalDesktopAssignmentType: string | undefined;
    /** Load balancer type. */
    loadBalancerType: string;
    /** Internal object ID of the host pool. */
    objectId: string | undefined;
    /** ARM IDs of the application groups that reference the host pool. */
    applicationGroupReferences: string[];
    /** Registration token for session hosts, when `registrationTokenTtlHours` is set. */
    registrationToken: Redacted.Redacted<string> | undefined;
    /** Expiration time (ISO 8601) of the registration token. */
    registrationTokenExpiration: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Virtual Desktop host pool — a collection of session host VMs
 * that users connect to. The host pool itself is a free metadata object;
 * cost comes from the session host VMs that register with it.
 *
 * @see https://learn.microsoft.com/azure/virtual-desktop/terminology
 *
 * ### Creating a Host Pool
 * **Example:** Pooled host pool
 * ```typescript
 * const pool = yield* Azure.DesktopVirtualization.HostPool("pool", {
 *   resourceGroup: group.resourceGroupName,
 *   hostPoolType: "Pooled",
 *   loadBalancerType: "BreadthFirst",
 *   maxSessionLimit: 10,
 * });
 * ```
 *
 * **Example:** Personal host pool with automatic assignment
 * ```typescript
 * const pool = yield* Azure.DesktopVirtualization.HostPool("personal", {
 *   resourceGroup: group.resourceGroupName,
 *   hostPoolType: "Personal",
 *   personalDesktopAssignmentType: "Automatic",
 *   loadBalancerType: "Persistent",
 * });
 * ```
 *
 * ### Registering Session Hosts
 * **Example:** Issue a registration token valid for one day
 * ```typescript
 * const pool = yield* Azure.DesktopVirtualization.HostPool("pool", {
 *   resourceGroup: group.resourceGroupName,
 *   hostPoolType: "Pooled",
 *   loadBalancerType: "DepthFirst",
 *   registrationTokenTtlHours: 24,
 * });
 * // pool.registrationToken is passed to the AVD agent on each session host.
 * ```
 *
 * @resource
 */
export const HostPool = Resource<HostPool>(
  "Azure.DesktopVirtualization.HostPool",
);

type ObservedHostPool = desktopvirtualization.GetHostPoolResponse;

const getHostPool = (
  subscriptionId: string,
  resourceGroupName: string,
  hostPoolName: string,
) =>
  orUndefinedIfNotFound(
    desktopvirtualization.GetHostPool({
      subscriptionId,
      resourceGroupName,
      hostPoolName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  pool: ObservedHostPool,
  token: desktopvirtualization.RegistrationInfo | undefined,
): HostPool["Attributes"] => ({
  hostPoolName: name,
  hostPoolId: pool.id ?? "",
  resourceGroup,
  location: pool.location,
  hostPoolType: pool.properties?.hostPoolType ?? "",
  personalDesktopAssignmentType:
    pool.properties?.personalDesktopAssignmentType ?? undefined,
  loadBalancerType: pool.properties?.loadBalancerType ?? "",
  objectId: pool.properties?.objectId,
  applicationGroupReferences: pool.properties?.applicationGroupReferences ?? [],
  registrationToken: token?.token ? Redacted.make(token.token) : undefined,
  registrationTokenExpiration: token?.token
    ? (token.expirationTime ?? undefined)
    : undefined,
  tags: userTags(pool.tags),
});

/** Desired mutable properties, `undefined` meaning "leave as observed". */
const desiredProperties = (news: HostPoolProps) => ({
  friendlyName: news.friendlyName,
  description: news.description,
  customRdpProperty: news.customRdpProperty,
  maxSessionLimit: news.maxSessionLimit,
  loadBalancerType: news.loadBalancerType,
  validationEnvironment: news.validationEnvironment,
  vmTemplate: news.vmTemplate,
  preferredAppGroupType: news.preferredAppGroupType ?? "Desktop",
  startVMOnConnect: news.startVMOnConnect,
  publicNetworkAccess: news.publicNetworkAccess,
  agentUpdate: news.agentUpdate,
});

const HOUR = 3_600_000;

export const HostPoolProvider = () =>
  Provider.succeed(HostPool, {
    stables: [
      "hostPoolName",
      "hostPoolId",
      "resourceGroup",
      "location",
      "hostPoolType",
      "objectId",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* desktopvirtualization
        .ListHostPools({ subscriptionId })
        .pipe(
          Effect.flatMap((page) => requireSinglePage("ListHostPools", page)),
        );
      return (page.value ?? []).flatMap((pool) => {
        const group = resourceGroupOf(pool.id);
        return hasAnyAlchemyTag(pool.tags) &&
          group !== undefined &&
          pool.name !== undefined
          ? [toAttrs(group, pool.name, pool, undefined)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.hostPoolName.toLowerCase()) ||
        (news.location !== undefined &&
          news.location.toLowerCase() !== output.location.toLowerCase()) ||
        news.hostPoolType.toLowerCase() !== output.hostPoolType.toLowerCase() ||
        (news.personalDesktopAssignmentType !== undefined &&
          news.personalDesktopAssignmentType.toLowerCase() !==
            (output.personalDesktopAssignmentType ?? "").toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.hostPoolName ?? olds?.name ?? (yield* createAvdName(id, 64));
      const observed = yield* getHostPool(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = {
        ...toAttrs(resourceGroup, name, observed, undefined),
        registrationToken: output?.registrationToken,
        registrationTokenExpiration: output?.registrationTokenExpiration,
      };
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(
        subscriptionId,
        "Microsoft.DesktopVirtualization",
      );
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.hostPoolName ?? (yield* createAvdName(id, 64));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const desired = desiredProperties(news);
      const request = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        hostPoolName: name,
      };

      // Observe.
      let observed: ObservedHostPool | undefined = yield* getHostPool(
        subscriptionId,
        resourceGroup,
        name,
      );

      // Ensure: the PUT is synchronous.
      if (observed === undefined) {
        observed = yield* desktopvirtualization.HostPoolsCreateOrUpdate({
          ...request,
          location,
          tags,
          properties: {
            ...desired,
            hostPoolType: news.hostPoolType,
            personalDesktopAssignmentType: news.personalDesktopAssignmentType,
          },
        });
      } else {
        // Sync: PATCH only the observed deltas.
        const delta = deltaOf(desired, observed.properties);
        const tagsChanged = tagsDiffer(observed.tags, tags);
        if (delta !== undefined || tagsChanged) {
          observed = yield* desktopvirtualization.UpdateHostPool({
            ...request,
            tags: tagsChanged ? tags : undefined,
            properties: delta,
          });
        }
      }

      // Registration token: reuse a token that is still valid for an hour,
      // otherwise issue a new one.
      let token: desktopvirtualization.RegistrationInfo | undefined;
      if (news.registrationTokenTtlHours !== undefined) {
        const now = yield* Clock.currentTimeMillis;
        const isValid = (info: desktopvirtualization.RegistrationInfo) =>
          !!info.token &&
          !!info.expirationTime &&
          Date.parse(info.expirationTime) > now + HOUR;
        token =
          yield* desktopvirtualization.GetHostPoolRegistrationToken(request);
        if (!isValid(token)) {
          const expirationTime = new Date(
            now + news.registrationTokenTtlHours * HOUR,
          ).toISOString();
          yield* desktopvirtualization.UpdateHostPool({
            ...request,
            properties: {
              registrationInfo: {
                expirationTime,
                registrationTokenOperation: "Update",
              },
            },
          });
          token =
            yield* desktopvirtualization.GetHostPoolRegistrationToken(request);
        }
      }

      return toAttrs(resourceGroup, name, observed, token);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        desktopvirtualization.DeleteHostPool({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          hostPoolName: output.hostPoolName,
          force: true,
        }),
      );
      yield* waitUntilGone(
        `host pool ${output.hostPoolName}`,
        getHostPool(subscriptionId, output.resourceGroup, output.hostPoolName),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
