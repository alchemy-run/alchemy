import * as web from "@distilled.cloud/azure/web";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
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
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { changedKeys, lower, sameLocation } from "./common.ts";

/** Which endpoints of the environment sit behind an internal load balancer. */
export type AppServiceEnvironmentLoadBalancing =
  | "None"
  | "Web"
  | "Publishing"
  | "Web, Publishing";

export interface AppServiceEnvironmentProps {
  /** Resource group the environment is created in. Changing it replaces it. */
  resourceGroup: string;
  /**
   * Name of the environment (2-36 letters, digits, and hyphens); it becomes
   * the `{name}.appserviceenvironment.net` DNS suffix. If omitted, a unique
   * name is generated from the app, stage, and logical ID. Changing it
   * replaces the environment.
   */
  name?: string;
  /**
   * Azure location; must match the subnet's virtual network. Changing it
   * replaces the environment.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM ID of an empty subnet delegated to `Microsoft.Web/hostingEnvironments`
   * (`/24` recommended). Changing it replaces the environment.
   */
  subnetId: string;
  /**
   * Internal load balancing: `None` exposes the environment publicly;
   * `Web, Publishing` makes it reachable only inside the virtual network.
   * Changing it replaces the environment.
   * @default "None"
   */
  internalLoadBalancingMode?: AppServiceEnvironmentLoadBalancing;
  /**
   * Spread the environment across availability zones. Changing it replaces
   * the environment.
   * @default false
   */
  zoneRedundant?: boolean;
  /**
   * Number of dedicated hosts (`2` for a dedicated-host deployment).
   * Changing it replaces the environment.
   * @default Azure's default (multi-tenant hardware)
   */
  dedicatedHostCount?: number;
  /** Scale factor for the front ends. */
  frontEndScaleFactor?: number;
  /** Cluster settings, e.g. `{ name: "DisableTls1.0", value: "1" }`. */
  clusterSettings?: { name: string; value: string }[];
  /**
   * When the environment receives platform upgrades.
   * @default Azure's default (`None`)
   */
  upgradePreference?: "None" | "Early" | "Late" | "Manual";
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface AppServiceEnvironment extends Resource<
  "Azure.Web.AppServiceEnvironment",
  AppServiceEnvironmentProps,
  {
    /** Name of the environment. */
    appServiceEnvironmentName: string;
    /** ARM resource ID; pass it as the plan's hosting environment. */
    appServiceEnvironmentId: string;
    /** Resource group that holds the environment. */
    resourceGroup: string;
    /** Location of the environment. */
    location: string;
    /** ARM ID of the environment's subnet. */
    subnetId: string;
    /** DNS suffix of the apps in the environment. */
    dnsSuffix: string | undefined;
    /** Status, e.g. `Ready`. */
    status: string | undefined;
    /** Internal load balancing mode. */
    internalLoadBalancingMode: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An App Service Environment v3 (`Microsoft.Web/hostingEnvironments`): a
 * single-tenant deployment of App Service injected into a virtual network
 * subnet, for Isolated v2 plans.
 *
 * Provisioning and deletion take one to three hours, and the environment
 * bills Isolated v2 capacity while it exists.
 *
 * @see https://learn.microsoft.com/azure/app-service/environment/overview
 *
 * ### Creating an Environment
 * **Example:** External ASEv3 in a delegated subnet
 * ```typescript
 * const subnet = yield* Azure.Network.Subnet("ase", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualNetwork: vnet.virtualNetworkName,
 *   addressPrefix: "10.0.0.0/24",
 *   delegations: [{ serviceName: "Microsoft.Web/hostingEnvironments" }],
 * });
 * const ase = yield* Azure.Web.AppServiceEnvironment("ase", {
 *   resourceGroup: group.resourceGroupName,
 *   subnetId: subnet.subnetId,
 * });
 * ```
 *
 * **Example:** Internal environment
 * ```typescript
 * const ase = yield* Azure.Web.AppServiceEnvironment("ase", {
 *   resourceGroup: group.resourceGroupName,
 *   subnetId: subnet.subnetId,
 *   internalLoadBalancingMode: "Web, Publishing",
 * });
 * ```
 *
 * @resource
 */
export const AppServiceEnvironment = Resource<AppServiceEnvironment>(
  "Azure.Web.AppServiceEnvironment",
);

const createEnvironmentName = (id: string) =>
  createPhysicalName({ id, maxLength: 36, lowercase: true });

type ObservedEnvironment = web.GetAppServiceEnvironmentResponse;

const getEnvironment = (
  subscriptionId: string,
  resourceGroupName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    web.GetAppServiceEnvironment({ subscriptionId, resourceGroupName, name }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: ObservedEnvironment,
) => ({
  appServiceEnvironmentName: name,
  appServiceEnvironmentId: observed.id ?? "",
  resourceGroup,
  location: observed.location,
  subnetId: observed.properties?.virtualNetwork.id ?? "",
  dnsSuffix: observed.properties?.dnsSuffix,
  status: observed.properties?.status,
  internalLoadBalancingMode: observed.properties?.internalLoadBalancingMode,
  tags: userTags(observed.tags),
});

const normalizeMode = (mode: string | undefined) =>
  (mode ?? "None").replaceAll(" ", "").toLowerCase();

// ASE provisioning and deletion take 1-3 hours.
const LONG_WAIT = { interval: "60 seconds", times: 200 } as const;

export const AppServiceEnvironmentProvider = () =>
  Provider.succeed(AppServiceEnvironment, {
    stables: [
      "appServiceEnvironmentName",
      "appServiceEnvironmentId",
      "resourceGroup",
      "location",
      "subnetId",
      "dnsSuffix",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* web
        .ListAppServiceEnvironments({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListAppServiceEnvironments", page),
          ),
        );
      return (page.value ?? []).flatMap((ase) => {
        const group = resourceGroupOf(ase.id);
        return hasAnyAlchemyTag(ase.tags) &&
          group !== undefined &&
          ase.name !== undefined
          ? [toAttrs(group, ase.name, ase)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.appServiceEnvironmentName)) ||
        (news.location !== undefined &&
          !sameLocation(news.location, output.location)) ||
        lower(news.subnetId) !== lower(output.subnetId) ||
        normalizeMode(news.internalLoadBalancingMode) !==
          normalizeMode(output.internalLoadBalancingMode) ||
        (news.zoneRedundant ?? false) !== (olds?.zoneRedundant ?? false) ||
        news.dedicatedHostCount !== olds?.dedicatedHostCount
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
        output?.appServiceEnvironmentName ??
        olds?.name ??
        (yield* createEnvironmentName(id));
      const observed = yield* getEnvironment(
        subscriptionId,
        resourceGroup,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Web");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.appServiceEnvironmentName ??
        (yield* createEnvironmentName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = { subscriptionId, resourceGroupName: resourceGroup, name };
      const get = getEnvironment(subscriptionId, resourceGroup, name);
      const waitReady = waitForProvisioned(
        `App Service Environment ${name}`,
        get,
        (observed) => observed.properties?.provisioningState,
        LONG_WAIT,
      );
      const mutable = {
        frontEndScaleFactor: news.frontEndScaleFactor,
        clusterSettings: news.clusterSettings,
        upgradePreference: news.upgradePreference,
      };
      const properties: web.AppServiceEnvironmentInput = {
        virtualNetwork: { id: news.subnetId },
        internalLoadBalancingMode: news.internalLoadBalancingMode ?? "None",
        zoneRedundant: news.zoneRedundant,
        dedicatedHostCount: news.dedicatedHostCount,
        ...mutable,
      };
      const put = web.AppServiceEnvironmentsCreateOrUpdate({
        ...where,
        location,
        kind: "ASEV3",
        tags,
        properties,
      });

      // Observe.
      let observed = yield* get;

      // Ensure. Creation is a long-running operation (hours).
      if (observed === undefined) {
        yield* put;
      }
      observed = yield* waitReady;

      // Sync tags. The PATCH body cannot carry tags, so re-send the PUT.
      if (tagsDiffer(observed.tags, tags)) {
        yield* put;
        observed = yield* waitReady;
      }

      // Sync mutable properties against observed state.
      const changed = changedKeys(mutable, observed.properties);
      if (Object.keys(changed).length > 0) {
        yield* web.UpdateAppServiceEnvironment({
          ...where,
          properties: { virtualNetwork: { id: news.subnetId }, ...changed },
        });
        observed = yield* waitReady;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        web.DeleteAppServiceEnvironment({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          name: output.appServiceEnvironmentName,
        }),
      );
      yield* waitUntilGone(
        `App Service Environment ${output.appServiceEnvironmentName}`,
        getEnvironment(
          subscriptionId,
          output.resourceGroup,
          output.appServiceEnvironmentName,
        ),
        LONG_WAIT,
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
