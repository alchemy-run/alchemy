import * as mdp from "@distilled.cloud/azure/devopsinfrastructure";
import * as Data from "effect/Data";
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

/** An Azure DevOps organization the pool serves. */
export interface PoolAzureDevOpsOrganization {
  /** Organization URL, e.g. `https://dev.azure.com/contoso`. */
  url: string;
  /**
   * Projects the pool is restricted to. Omit to make the pool available to
   * every project in the organization.
   */
  projects?: string[];
  /**
   * Maximum number of agents this organization may use out of the pool's
   * `maximumConcurrency`. Required when the pool serves several
   * organizations.
   */
  parallelism?: number;
  /** Whether every pipeline in the selected projects may use the pool. */
  openAccess?: boolean;
}

/** Pool serving one or more Azure DevOps organizations. */
export interface PoolAzureDevOpsOrganizationProfile {
  kind: "AzureDevOps";
  /** Organizations the pool is registered in. */
  organizations: PoolAzureDevOpsOrganization[];
  /**
   * Who administers the agent pool in Azure DevOps.
   * @default { kind: "CreatorOnly" }
   */
  permissionProfile?: {
    /** `CreatorOnly`, `Inherit` (project permissions), or `SpecificAccounts`. */
    kind: "CreatorOnly" | "Inherit" | "SpecificAccounts";
    /** User emails, for `SpecificAccounts`. */
    users?: string[];
    /** Group emails, for `SpecificAccounts`. */
    groups?: string[];
  };
}

/** A GitHub organization the pool serves as self-hosted runners. */
export interface PoolGitHubOrganization {
  /** Organization URL, e.g. `https://github.com/contoso`. */
  url: string;
  /** Repositories the runners are restricted to. Omit for all. */
  repositories?: string[];
}

/** Pool serving GitHub organizations (GitHub Actions runners). */
export interface PoolGitHubOrganizationProfile {
  kind: "GitHub";
  /** Organizations the runners are registered in. */
  organizations: PoolGitHubOrganization[];
}

export type PoolOrganizationProfile =
  | PoolAzureDevOpsOrganizationProfile
  | PoolGitHubOrganizationProfile;

/** How stand-by agents are kept warm. */
export type PoolResourcePredictionsProfile =
  | { kind: "Manual" }
  | {
      kind: "Automatic";
      /**
       * Balance between cost and performance.
       * @default "Balanced"
       */
      predictionPreference?:
        | "Balanced"
        | "MostCostEffective"
        | "MoreCostEffective"
        | "MorePerformance"
        | "BestPerformance";
    };

interface PoolAgentProfileBase {
  /**
   * Manual stand-by schedule (`{ timeZone, daysData }`), used with a
   * `Manual` resource predictions profile.
   */
  resourcePredictions?: Record<string, unknown>;
  /** How stand-by agents are provided. */
  resourcePredictionsProfile?: PoolResourcePredictionsProfile;
}

/** Every agent runs exactly one job on a fresh machine. */
export interface PoolStatelessAgentProfile extends PoolAgentProfileBase {
  kind: "Stateless";
}

/** Machines are reused across jobs until their lifetime ends. */
export interface PoolStatefulAgentProfile extends PoolAgentProfileBase {
  kind: "Stateful";
  /** Maximum lifetime of a machine, `d.hh:mm:ss`. @default "7.00:00:00" */
  maxAgentLifetime?: string;
  /** How long an idle machine is kept, `d.hh:mm:ss`. */
  gracePeriodTimeSpan?: string;
}

export type PoolAgentProfile =
  | PoolStatelessAgentProfile
  | PoolStatefulAgentProfile;

/** A VM image used by pool machines. */
export interface PoolImage {
  /**
   * Well-known image, e.g. `windows-2022/latest` or `ubuntu-22.04/latest`.
   * Set this or `resourceId`.
   */
  wellKnownImageName?: string;
  /** ARM ID of an Azure Compute Gallery image (version). */
  resourceId?: string;
  /** Aliases pipelines use to demand this image. */
  aliases?: string[];
  /** Percentage of stand-by agents allocated to this image, or `*`. */
  buffer?: string;
  /** `Automatic`, `CacheDisk`, or `ResourceDisk`. */
  ephemeralType?: "Automatic" | "CacheDisk" | "ResourceDisk";
}

/** Machines are Azure VM scale set instances managed by the service. */
export interface PoolVmssFabricProfile {
  kind: "Vmss";
  /** VM SKU of the machines. */
  sku: {
    /** VM size, e.g. `Standard_D2ads_v5`. */
    name: string;
  };
  /** Images available to pipelines. */
  images: PoolImage[];
  /** Operating system settings. */
  osProfile?: {
    /** Key Vault certificates installed on every machine. */
    secretsManagementSettings?: {
      /** Certificate store location on the machine. */
      certificateStoreLocation?: string;
      /** Certificate store name (`My` or `Root`). */
      certificateStoreName?: "My" | "Root";
      /** Key Vault secret URIs of the certificates. */
      observedCertificates: string[];
      /** Whether the private keys are exportable. */
      keyExportable: boolean;
    };
    /** How the agent runs on Windows: `Service` or `Interactive`. */
    logonType?: "Service" | "Interactive";
  };
  /** Disk settings. */
  storageProfile?: {
    /** OS disk type: `Standard`, `Premium`, or `StandardSSD`. */
    osDiskStorageAccountType?: "Standard" | "Premium" | "StandardSSD";
    /** Empty data disks attached to every machine. */
    dataDisks?: {
      /** `None`, `ReadOnly`, or `ReadWrite`. */
      caching?: "None" | "ReadOnly" | "ReadWrite";
      /** Size in GiB. */
      diskSizeGiB?: number;
      /** Disk storage account type, e.g. `Premium_LRS`. */
      storageAccountType?: string;
      /** Drive letter on Windows. */
      driveLetter?: string;
    }[];
  };
  /** Network settings. Omit to use a service-managed network. */
  networkProfile?: {
    /** ARM ID of a subnet (delegated to `Microsoft.DevOpsInfrastructure/pools`). */
    subnetId?: string;
    /** Number of static public IPs for outbound traffic. */
    staticIpAddressCount?: number;
  };
}

export interface PoolIdentity {
  /** `None` or `UserAssigned`. */
  type: "None" | "UserAssigned";
  /** ARM IDs of user-assigned identities, for `UserAssigned`. */
  userAssignedIdentities?: string[];
}

export interface PoolProps {
  /** Resource group the pool is created in. Changing it replaces the pool. */
  resourceGroup: string;
  /**
   * Pool name, 3-44 characters of letters, digits, `-`, `_` and `.`, unique
   * within the Azure DevOps organization. If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces the
   * pool.
   */
  name?: string;
  /**
   * Azure location of the pool. Changing it replaces the pool.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /** ARM ID of the Dev Center project the pool belongs to. */
  devCenterProjectResourceId: string;
  /** Maximum number of agents that can run at the same time. */
  maximumConcurrency: number;
  /**
   * Azure DevOps or GitHub organizations the pool serves. Changing `kind`
   * replaces the pool.
   */
  organizationProfile: PoolOrganizationProfile;
  /**
   * Whether machines are reused between jobs.
   * @default { kind: "Stateless" }
   */
  agentProfile?: PoolAgentProfile;
  /** Machines, images, disks, and networking of the pool. */
  fabricProfile: PoolVmssFabricProfile;
  /** Agent runtime settings. */
  runtimeConfiguration?: {
    /** Work folder of the agent on the machine. */
    workFolder?: string;
  };
  /** Managed identity of the pool (e.g. for Key Vault certificates). */
  identity?: PoolIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Pool extends Resource<
  "Azure.DevOpsInfrastructure.Pool",
  PoolProps,
  {
    /** Name of the pool. */
    poolName: string;
    /** Resource group that holds the pool. */
    resourceGroup: string;
    /** ARM resource ID of the pool. */
    poolId: string;
    /** Location of the pool. */
    location: string;
    /** ARM ID of the Dev Center project the pool belongs to. */
    devCenterProjectResourceId: string;
    /** Maximum number of concurrent agents. */
    maximumConcurrency: number;
    /** Organization profile kind (`AzureDevOps` or `GitHub`). */
    organizationKind: string;
    /** Agent profile kind (`Stateless` or `Stateful`). */
    agentKind: string;
    /** Last provisioning state reported by ARM. */
    provisioningState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A Managed DevOps Pool — Azure-hosted, auto-scaling Azure Pipelines agents
 * (or GitHub Actions runners) running in VM scale sets that Microsoft
 * manages in your subscription. A pool belongs to a Dev Center project and
 * registers itself as an agent pool in the given Azure DevOps organizations.
 *
 * The Azure DevOps organization must be connected to the subscription's
 * Microsoft Entra tenant, and the `DevOpsInfrastructure` service principal
 * needs Reader + Network Contributor on any custom subnet.
 *
 * @see https://learn.microsoft.com/azure/devops/managed-devops-pools/overview
 *
 * ### Creating a Pool
 * **Example:** Stateless Ubuntu pool for an Azure DevOps organization
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("ci");
 * const center = yield* Azure.DevCenter.DevCenter("ci", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const project = yield* Azure.DevCenter.Project("ci", {
 *   resourceGroup: group.resourceGroupName,
 *   devCenterId: center.devCenterId,
 * });
 * const pool = yield* Azure.DevOpsInfrastructure.Pool("agents", {
 *   resourceGroup: group.resourceGroupName,
 *   devCenterProjectResourceId: project.projectId,
 *   maximumConcurrency: 2,
 *   organizationProfile: {
 *     kind: "AzureDevOps",
 *     organizations: [{ url: "https://dev.azure.com/contoso" }],
 *   },
 *   fabricProfile: {
 *     kind: "Vmss",
 *     sku: { name: "Standard_D2ads_v5" },
 *     images: [{ wellKnownImageName: "ubuntu-22.04/latest" }],
 *   },
 * });
 * ```
 *
 * ### Stand-by Agents
 * **Example:** Stateful pool with automatic stand-by agents
 * ```typescript
 * const pool = yield* Azure.DevOpsInfrastructure.Pool("warm", {
 *   resourceGroup: group.resourceGroupName,
 *   devCenterProjectResourceId: project.projectId,
 *   maximumConcurrency: 4,
 *   organizationProfile: {
 *     kind: "AzureDevOps",
 *     organizations: [{ url: "https://dev.azure.com/contoso", projects: ["web"] }],
 *   },
 *   agentProfile: {
 *     kind: "Stateful",
 *     maxAgentLifetime: "7.00:00:00",
 *     gracePeriodTimeSpan: "00:30:00",
 *     resourcePredictionsProfile: {
 *       kind: "Automatic",
 *       predictionPreference: "Balanced",
 *     },
 *   },
 *   fabricProfile: {
 *     kind: "Vmss",
 *     sku: { name: "Standard_D4ads_v5" },
 *     images: [{ wellKnownImageName: "windows-2022/latest", buffer: "*" }],
 *   },
 * });
 * ```
 *
 * ### GitHub Actions Runners
 * **Example:** Pool serving a GitHub organization
 * ```typescript
 * const runners = yield* Azure.DevOpsInfrastructure.Pool("runners", {
 *   resourceGroup: group.resourceGroupName,
 *   devCenterProjectResourceId: project.projectId,
 *   maximumConcurrency: 2,
 *   organizationProfile: {
 *     kind: "GitHub",
 *     organizations: [{ url: "https://github.com/contoso", repositories: ["api"] }],
 *   },
 *   fabricProfile: {
 *     kind: "Vmss",
 *     sku: { name: "Standard_D2ads_v5" },
 *     images: [{ wellKnownImageName: "ubuntu-24.04/latest" }],
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Pool = Resource<Pool>("Azure.DevOpsInfrastructure.Pool");

/**
 * The service accepted the create and then removed the pool because its
 * asynchronous validation failed (typically `OrganizationNotFound`).
 */
export class PoolCreateRejected extends Data.TaggedError(
  "Azure.DevOpsInfrastructure.PoolCreateRejected",
)<{
  readonly poolName: string;
  readonly message: string;
}> {}

type ObservedPool = mdp.GetPoolResponse;

const createPoolName = (id: string) =>
  createPhysicalName({ id, maxLength: 44, lowercase: true });

const getPool = (
  subscriptionId: string,
  resourceGroupName: string,
  poolName: string,
) =>
  orUndefinedIfNotFound(
    mdp.GetPool({ subscriptionId, resourceGroupName, poolName }),
  );

const sameArm = (a: string | undefined, b: string | undefined) =>
  a?.toLowerCase() === b?.toLowerCase();

/**
 * True when every value set in `desired` is present in `observed`. ARM
 * fills in defaults (image buffers, permission profiles, ephemeral types),
 * so keys absent from `desired` are not compared. Arrays must match
 * element-wise.
 */
const covers = (observed: unknown, desired: unknown): boolean => {
  if (desired === undefined || desired === null) return true;
  if (Array.isArray(desired)) {
    return (
      Array.isArray(observed) &&
      observed.length === desired.length &&
      desired.every((value, i) => covers(observed[i], value))
    );
  }
  if (typeof desired === "object") {
    if (observed === null || typeof observed !== "object") return false;
    return Object.entries(desired as Record<string, unknown>).every(
      ([key, value]) =>
        covers((observed as Record<string, unknown>)[key], value),
    );
  }
  if (typeof desired === "string" && typeof observed === "string") {
    return desired.toLowerCase() === observed.toLowerCase();
  }
  return desired === observed;
};

const toIdentity = (identity: PoolIdentity | undefined) =>
  identity === undefined
    ? undefined
    : {
        type: identity.type,
        userAssignedIdentities:
          identity.userAssignedIdentities === undefined
            ? undefined
            : Object.fromEntries(
                identity.userAssignedIdentities.map((id) => [id, {}]),
              ),
      };

const identityDiffers = (
  observed: ObservedPool["identity"],
  desired: PoolIdentity | undefined,
) => {
  if (desired === undefined) return false;
  if ((observed?.type ?? "None") !== desired.type) return true;
  const have = Object.keys(observed?.userAssignedIdentities ?? {})
    .map((id) => id.toLowerCase())
    .sort();
  const want = (desired.userAssignedIdentities ?? [])
    .map((id) => id.toLowerCase())
    .sort();
  return JSON.stringify(have) !== JSON.stringify(want);
};

const toAttrs = (
  resourceGroup: string,
  name: string,
  pool: ObservedPool,
): Pool["Attributes"] => ({
  poolName: name,
  resourceGroup,
  poolId: pool.id ?? "",
  location: pool.location,
  devCenterProjectResourceId: pool.properties?.devCenterProjectResourceId ?? "",
  maximumConcurrency: pool.properties?.maximumConcurrency ?? 0,
  organizationKind: pool.properties?.organizationProfile.kind ?? "",
  agentKind: pool.properties?.agentProfile.kind ?? "",
  provisioningState: pool.properties?.provisioningState,
  tags: userTags(pool.tags),
});

/** Pools can take 10-15 minutes to provision their scale set. */
const PROVISION_BUDGET = { interval: "15 seconds", times: 60 } as const;

export const PoolProvider = () =>
  Provider.succeed(Pool, {
    stables: ["poolName", "resourceGroup", "poolId", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* mdp
        .ListPoolBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListPoolBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((pool) => {
        const group = resourceGroupOf(pool.id);
        return hasAnyAlchemyTag(pool.tags) &&
          group !== undefined &&
          pool.name !== undefined
          ? [toAttrs(group, pool.name, pool)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && !sameArm(news.name, output.poolName)) ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location)) ||
        (output.organizationKind !== "" &&
          !sameArm(news.organizationProfile.kind, output.organizationKind))
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
        output?.poolName ?? olds?.name ?? (yield* createPoolName(id));
      const observed = yield* getPool(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.DevOpsInfrastructure");
      const resourceGroup = news.resourceGroup;
      const name = news.name ?? output?.poolName ?? (yield* createPoolName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const properties = {
        devCenterProjectResourceId: news.devCenterProjectResourceId,
        maximumConcurrency: news.maximumConcurrency,
        organizationProfile: news.organizationProfile,
        agentProfile: news.agentProfile ?? { kind: "Stateless" },
        fabricProfile: news.fabricProfile,
        runtimeConfiguration: news.runtimeConfiguration,
      } satisfies mdp.PoolProperties;
      const identity = toIdentity(news.identity);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        poolName: name,
      };
      const label = `managed devops pool ${name}`;
      const get = getPool(subscriptionId, resourceGroup, name);
      const stateOf = (pool: ObservedPool) =>
        pool.properties?.provisioningState;

      // Observe.
      let observed = yield* get;

      // Ensure. The PUT is a long-running operation that provisions the
      // pool's scale set and registers the agent pool in Azure DevOps.
      let created = false;
      if (observed === undefined) {
        yield* mdp.PoolsCreateOrUpdate({
          ...where,
          location,
          tags,
          identity,
          properties,
        });
        created = true;
      }
      // The PUT returns 201 with the pool visible. When the asynchronous
      // validation fails (e.g. `OrganizationNotFound`: the Azure DevOps
      // organization does not exist or is not connected to this tenant) the
      // service deletes the pool instead of leaving it `Failed`, and the
      // reason is only on the Azure-AsyncOperation status. A pool that
      // vanishes after its create is therefore a rejected create.
      let misses = 0;
      const getAfterCreate = get.pipe(
        Effect.flatMap((pool) => {
          if (pool !== undefined || !created) {
            misses = 0;
            return Effect.succeed(pool);
          }
          misses += 1;
          return misses < 3
            ? Effect.succeed(undefined)
            : Effect.fail(
                new PoolCreateRejected({
                  poolName: name,
                  message: `${label} was accepted and then removed by the service; its asynchronous validation failed. Check that the Azure DevOps organization exists and is connected to this Microsoft Entra tenant, and that devCenterProjectResourceId, the SKU, and images are valid.`,
                }),
              );
        }),
      );
      observed = yield* waitForProvisioned(
        label,
        getAfterCreate,
        stateOf,
        PROVISION_BUDGET,
      );

      // Sync each mutable aspect against observed state; PATCH only deltas.
      const current = observed.properties;
      const delta: mdp.PoolUpdateProperties = {
        devCenterProjectResourceId: sameArm(
          current?.devCenterProjectResourceId,
          properties.devCenterProjectResourceId,
        )
          ? undefined
          : properties.devCenterProjectResourceId,
        maximumConcurrency:
          current?.maximumConcurrency === properties.maximumConcurrency
            ? undefined
            : properties.maximumConcurrency,
        organizationProfile: covers(
          current?.organizationProfile,
          properties.organizationProfile,
        )
          ? undefined
          : properties.organizationProfile,
        agentProfile: covers(current?.agentProfile, properties.agentProfile)
          ? undefined
          : properties.agentProfile,
        fabricProfile: covers(current?.fabricProfile, properties.fabricProfile)
          ? undefined
          : properties.fabricProfile,
        runtimeConfiguration: covers(
          current?.runtimeConfiguration,
          properties.runtimeConfiguration,
        )
          ? undefined
          : properties.runtimeConfiguration,
      };
      const propsChanged = Object.values(delta).some((v) => v !== undefined);
      const identityChanged = identityDiffers(observed.identity, news.identity);
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (propsChanged || identityChanged || tagsChanged) {
        yield* mdp.UpdatePool({
          ...where,
          tags: tagsChanged ? tags : undefined,
          identity: identityChanged ? identity : undefined,
          properties: propsChanged ? delta : undefined,
        });
        observed = yield* waitForProvisioned(
          label,
          get,
          stateOf,
          PROVISION_BUDGET,
        );
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        mdp.DeletePool({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          poolName: output.poolName,
        }),
      );
      yield* waitUntilGone(
        `managed devops pool ${output.poolName}`,
        getPool(subscriptionId, output.resourceGroup, output.poolName),
        PROVISION_BUDGET,
      );
    }),

    nuke: {
      dependsOn: ["Azure.DevCenter.Project", "Azure.Resources.ResourceGroup"],
    },
  });
