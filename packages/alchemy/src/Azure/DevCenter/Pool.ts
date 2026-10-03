import * as devcenter from "@distilled.cloud/azure/devcenter";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
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
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { createDevCenterName, sameArm, sameValue } from "./Common.ts";

export type PoolEnableStatus = "Enabled" | "Disabled";

/** Auto-stop setting of a pool. */
export interface PoolStopSetting {
  /** Whether the setting is enabled. */
  status: PoolEnableStatus;
  /** Minutes to wait before stopping the dev box. */
  gracePeriodMinutes?: number;
}

export interface PoolProps {
  /** Resource group of the project. Changing it replaces the pool. */
  resourceGroup: string;
  /** Name of the project. Changing it replaces the pool. */
  project: string;
  /**
   * Pool name: 3-63 letters, digits, hyphens, underscores, and periods.
   * If omitted, a unique name is generated from the app, stage, and
   * logical ID. Changing it replaces the pool.
   */
  name?: string;
  /**
   * Azure location of the pool. Changing it replaces the pool.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /** Name of the dev center's dev box definition the pool creates dev boxes from. */
  devBoxDefinitionName: string;
  /**
   * Name of the dev center's attached network, or `managedNetwork` for a
   * Microsoft-hosted network (requires the dev center's
   * `microsoftHostedNetworkEnableStatus: "Enabled"`).
   * @default "managedNetwork"
   */
  networkConnectionName?: string;
  /**
   * `Managed` for a Microsoft-hosted network, `Unmanaged` for an attached
   * network connection.
   * @default "Managed" when `networkConnectionName` is `managedNetwork`, else "Unmanaged"
   */
  virtualNetworkType?: "Managed" | "Unmanaged";
  /**
   * Regions of the Microsoft-hosted network. Only used with
   * `virtualNetworkType: "Managed"`.
   * @default the pool's location
   */
  managedVirtualNetworkRegions?: string[];
  /**
   * Whether dev box owners are local administrators.
   * @default "Enabled"
   */
  localAdministrator?: PoolEnableStatus;
  /** Whether single sign-on is enabled for dev boxes of the pool. */
  singleSignOnStatus?: PoolEnableStatus;
  /** Stop dev boxes after the user disconnects. */
  stopOnDisconnect?: PoolStopSetting;
  /** Stop dev boxes the user never connected to. */
  stopOnNoConnect?: PoolStopSetting;
  /** Display name of the pool. */
  displayName?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Pool extends Resource<
  "Azure.DevCenter.Pool",
  PoolProps,
  {
    /** Name of the pool. */
    poolName: string;
    /** ARM resource ID of the pool. */
    poolId: string;
    /** Name of the project. */
    project: string;
    /** Resource group of the project. */
    resourceGroup: string;
    /** Location of the pool. */
    location: string;
    /** Name of the dev box definition. */
    devBoxDefinitionName: string;
    /** Name of the network connection (`managedNetwork` when Microsoft-hosted). */
    networkConnectionName: string;
    /** Health of the pool (`Healthy`, `Warning`, `Unhealthy`, `Pending`, ...). */
    healthStatus: string | undefined;
    /** Number of dev boxes in the pool. */
    devBoxCount: number | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A dev box pool — the collection of dev boxes that developers of a
 * project create from one dev box definition on one network. Creating a
 * pool provisions no VMs and is free; dev boxes are billed per hour once
 * developers create them.
 *
 * @see https://learn.microsoft.com/azure/dev-box/how-to-manage-dev-box-pools
 *
 * ### Creating a Pool
 * **Example:** Pool on a Microsoft-hosted network
 * ```typescript
 * const center = yield* Azure.DevCenter.DevCenter("center", {
 *   resourceGroup: group.resourceGroupName,
 *   microsoftHostedNetworkEnableStatus: "Enabled",
 * });
 * const pool = yield* Azure.DevCenter.Pool("pool", {
 *   resourceGroup: group.resourceGroupName,
 *   project: project.projectName,
 *   devBoxDefinitionName: definition.devBoxDefinitionName,
 * });
 * ```
 *
 * **Example:** Pool on an attached network with auto-stop
 * ```typescript
 * const pool = yield* Azure.DevCenter.Pool("pool", {
 *   resourceGroup: group.resourceGroupName,
 *   project: project.projectName,
 *   devBoxDefinitionName: definition.devBoxDefinitionName,
 *   networkConnectionName: attached.attachedNetworkName,
 *   stopOnDisconnect: { status: "Enabled", gracePeriodMinutes: 60 },
 * });
 * ```
 *
 * @resource
 */
export const Pool = Resource<Pool>("Azure.DevCenter.Pool");

type Observed = devcenter.GetPoolResponse;

const getPool = (
  subscriptionId: string,
  resourceGroupName: string,
  projectName: string,
  poolName: string,
) =>
  orUndefinedIfNotFound(
    devcenter.GetPool({
      subscriptionId,
      resourceGroupName,
      projectName,
      poolName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  project: string,
  name: string,
  observed: Observed,
): Pool["Attributes"] => ({
  poolName: name,
  poolId: observed.id ?? "",
  project,
  resourceGroup,
  location: observed.location,
  devBoxDefinitionName: observed.properties?.devBoxDefinitionName ?? "",
  networkConnectionName: observed.properties?.networkConnectionName ?? "",
  healthStatus: observed.properties?.healthStatus,
  devBoxCount: observed.properties?.devBoxCount,
  tags: userTags(observed.tags),
});

/** Desired mutable pool properties; `undefined` members are left as-is. */
const desiredProperties = (
  news: PoolProps,
  location: string,
): devcenter.PoolUpdatePropertiesInput => {
  const networkConnectionName = news.networkConnectionName ?? "managedNetwork";
  const virtualNetworkType =
    news.virtualNetworkType ??
    (networkConnectionName === "managedNetwork" ? "Managed" : "Unmanaged");
  return {
    devBoxDefinitionName: news.devBoxDefinitionName,
    networkConnectionName,
    virtualNetworkType,
    managedVirtualNetworkRegions:
      virtualNetworkType === "Managed"
        ? (news.managedVirtualNetworkRegions ?? [location])
        : undefined,
    licenseType: "Windows_Client",
    localAdministrator: news.localAdministrator ?? "Enabled",
    singleSignOnStatus: news.singleSignOnStatus,
    stopOnDisconnect: news.stopOnDisconnect,
    stopOnNoConnect: news.stopOnNoConnect,
    displayName: news.displayName,
  };
};

const normalizeRegions = (regions: readonly string[] | undefined) =>
  regions?.map((region) => region.toLowerCase()).sort();

/** Only the members that differ from the observed pool. */
const propertiesDelta = (
  observed: devcenter.PoolProperties | undefined,
  desired: devcenter.PoolUpdatePropertiesInput,
): devcenter.PoolUpdatePropertiesInput | undefined => {
  const delta: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(desired)) {
    if (value === undefined) continue;
    const have = (observed as Record<string, unknown> | undefined)?.[key];
    const same =
      key === "managedVirtualNetworkRegions"
        ? sameValue(
            normalizeRegions(have as string[] | undefined),
            normalizeRegions(value as string[]),
          )
        : key === "devBoxDefinitionName" || key === "networkConnectionName"
          ? sameArm(have as string | undefined, value as string)
          : sameValue(have, value);
    if (!same) delta[key] = value;
  }
  return Object.keys(delta).length > 0
    ? (delta as devcenter.PoolUpdatePropertiesInput)
    : undefined;
};

/** A fresh dev box definition or attached network can lag behind the pool PUT. */
const whilePending = {
  while: (e: { readonly _tag: string }) => e._tag === "ResourceConflict",
  schedule: Schedule.spaced("10 seconds"),
  times: 12,
} as const;

export const PoolProvider = () =>
  Provider.succeed(Pool, {
    stables: ["poolName", "poolId", "project", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const projects = yield* devcenter
        .ListProjectBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListProjectBySubscription", page),
          ),
        );
      const owned = (projects.value ?? []).flatMap((project) => {
        const resourceGroup = resourceGroupOf(project.id);
        return hasAnyAlchemyTag(project.tags) &&
          resourceGroup !== undefined &&
          project.name !== undefined
          ? [{ resourceGroup, projectName: project.name }]
          : [];
      });
      const pools = yield* Effect.forEach(owned, ({ resourceGroup, projectName }) =>
        devcenter
          .ListPoolByProject({
            subscriptionId,
            resourceGroupName: resourceGroup,
            projectName,
          })
          .pipe(
            Effect.flatMap((page) =>
              requireSinglePage("ListPoolByProject", page),
            ),
            Effect.map((page) =>
              (page.value ?? []).flatMap((pool) =>
                hasAnyAlchemyTag(pool.tags) && pool.name !== undefined
                  ? [toAttrs(resourceGroup, projectName, pool.name, pool)]
                  : [],
              ),
            ),
            orUndefinedIfNotFound,
            Effect.map((attrs) => attrs ?? []),
          ),
      );
      return pools.flat();
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.project, output.project) ||
        (news.name !== undefined && !sameArm(news.name, output.poolName)) ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const project = output?.project ?? olds?.project;
      if (resourceGroup === undefined || project === undefined) {
        return undefined;
      }
      const name =
        output?.poolName ?? olds?.name ?? (yield* createDevCenterName(id));
      const observed = yield* getPool(
        subscriptionId,
        resourceGroup,
        project,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, project, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.DevCenter");
      const { resourceGroup, project } = news;
      const name =
        news.name ?? output?.poolName ?? (yield* createDevCenterName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const desired = desiredProperties(news, location);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        projectName: project,
        poolName: name,
      };
      const label = `dev box pool ${name}`;
      const get = getPool(subscriptionId, resourceGroup, project, name);
      const stateOf = (observed: Observed) =>
        observed.properties?.provisioningState;

      // Observe.
      let observed = yield* get;

      // Ensure. The PUT is a long-running operation.
      if (observed === undefined) {
        yield* devcenter
          .PoolsCreateOrUpdate({
            ...where,
            location,
            tags,
            properties: {
              ...desired,
              devBoxDefinitionName: news.devBoxDefinitionName,
              networkConnectionName: desired.networkConnectionName!,
              licenseType: desired.licenseType!,
              localAdministrator: desired.localAdministrator!,
            },
          })
          .pipe(Effect.retry(whilePending));
      }
      observed = yield* waitForProvisioned(label, get, stateOf, {
        interval: "5 seconds",
        times: 90,
      });

      // Sync mutable properties and tags against observed state.
      const delta = propertiesDelta(observed.properties, desired);
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (delta !== undefined || tagsChanged) {
        yield* devcenter
          .UpdatePool({
            ...where,
            tags: tagsChanged ? tags : undefined,
            properties: delta,
          })
          .pipe(Effect.retry(whilePending));
        observed = yield* waitForProvisioned(label, get, stateOf, {
          interval: "5 seconds",
          times: 90,
        });
      }

      return toAttrs(resourceGroup, project, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        devcenter.DeletePool({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          projectName: output.project,
          poolName: output.poolName,
        }),
      );
      yield* waitUntilGone(
        `dev box pool ${output.poolName}`,
        getPool(
          subscriptionId,
          output.resourceGroup,
          output.project,
          output.poolName,
        ),
        { interval: "5 seconds", times: 90 },
      );
    }),

    nuke: {
      dependsOn: ["Azure.DevCenter.Project", "Azure.Resources.ResourceGroup"],
    },
  });
