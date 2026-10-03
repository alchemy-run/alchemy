import * as dr from "@distilled.cloud/azure/recoveryservicesdatareplication";
import * as Effect from "effect/Effect";
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
import {
  createDataReplicationName,
  DATA_REPLICATION_NAMESPACE,
  type DataReplicationCustomProperties,
  matchesDesired,
  sameName,
} from "./Shared.ts";

export interface FabricProps {
  /**
   * Resource group the fabric is created in. Changing it replaces the
   * fabric.
   */
  resourceGroup: string;
  /**
   * Name of the fabric: letters and digits only. If omitted, a unique name
   * is generated from the app, stage, and logical ID. Changing it replaces
   * the fabric.
   */
  name?: string;
  /**
   * Azure location of the fabric. Changing it replaces the fabric.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Fabric settings, discriminated by `instanceType`:
   * - `HyperVMigrate` — `{ hyperVSiteId, migrationSolutionId }` (Azure
   *   Migrate Hyper-V site and solution)
   * - `VMwareMigrate` — `{ vmwareSiteId, migrationSolutionId }`
   * - `AzStackHCI` — `{ azStackHciSiteId, migrationSolutionId, cluster: {
   *   clusterName, resourceName, storageAccountName, storageContainers } }`
   *
   * Changing `instanceType` replaces the fabric; other fields are updated
   * in place.
   */
  customProperties: DataReplicationCustomProperties;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Fabric extends Resource<
  "Azure.DataReplication.Fabric",
  FabricProps,
  {
    /** Name of the fabric. */
    fabricName: string;
    /** Resource group that holds the fabric. */
    resourceGroup: string;
    /** ARM resource ID of the fabric. */
    fabricId: string;
    /** Location of the fabric. */
    location: string;
    /** Fabric type (`HyperVMigrate`, `VMwareMigrate`, or `AzStackHCI`). */
    instanceType: string | undefined;
    /** Service endpoint of the fabric. */
    serviceEndpoint: string | undefined;
    /** ID of the backing service resource. */
    serviceResourceId: string | undefined;
    /** Fabric health: `Normal`, `Warning`, or `Critical`. */
    health: string | undefined;
    /** Provisioning state of the fabric. */
    provisioningState: string | undefined;
    /** Observed fabric settings. */
    customProperties: Record<string, unknown> | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Site Recovery data replication fabric
 * (`Microsoft.DataReplication/replicationFabrics`) — the representation
 * of a replication source or target: an Azure Migrate Hyper-V or VMware
 * site, or an Azure Local (Azure Stack HCI) cluster. A replication
 * extension links a source fabric to a target fabric inside a vault.
 *
 * A fabric needs a real Azure Migrate project with a registered appliance
 * (or an Azure Local cluster); the service discards fabrics whose site
 * does not exist.
 *
 * @see https://learn.microsoft.com/azure/azure-local/migrate/migration-azure-migrate-overview
 *
 * ### Creating a Fabric
 * **Example:** Hyper-V source fabric
 * ```typescript
 * const source = yield* Azure.DataReplication.Fabric("hyperv", {
 *   resourceGroup: group.resourceGroupName,
 *   customProperties: {
 *     instanceType: "HyperVMigrate",
 *     hyperVSiteId: hyperVSite.siteId,
 *     migrationSolutionId: solution.solutionId,
 *   },
 * });
 * ```
 *
 * **Example:** Azure Local target fabric
 * ```typescript
 * const target = yield* Azure.DataReplication.Fabric("azlocal", {
 *   resourceGroup: group.resourceGroupName,
 *   customProperties: {
 *     instanceType: "AzStackHCI",
 *     azStackHciSiteId: hciSite.siteId,
 *     migrationSolutionId: solution.solutionId,
 *     cluster: {
 *       clusterName: "hci-cluster",
 *       resourceName: "hci-cluster",
 *       storageAccountName: "hcistorage",
 *       storageContainers: [],
 *     },
 *   },
 *   tags: { team: "infra" },
 * });
 * ```
 *
 * @resource
 */
export const Fabric = Resource<Fabric>("Azure.DataReplication.Fabric");

type Observed = dr.GetFabricResponse;

interface Where {
  subscriptionId: string;
  resourceGroupName: string;
  fabricName: string;
}

const getFabric = (where: Where) => orUndefinedIfNotFound(dr.GetFabric(where));

const customOf = (fabric: { properties?: { customProperties?: unknown } }) =>
  (fabric.properties?.customProperties ?? undefined) as
    | Record<string, unknown>
    | undefined;

const toAttrs = (
  resourceGroup: string,
  name: string,
  fabric: Observed,
): Fabric["Attributes"] => {
  const custom = customOf(fabric);
  return {
    fabricName: name,
    resourceGroup,
    fabricId: fabric.id ?? "",
    location: fabric.location,
    instanceType:
      typeof custom?.instanceType === "string"
        ? custom.instanceType
        : undefined,
    serviceEndpoint: fabric.properties?.serviceEndpoint,
    serviceResourceId: fabric.properties?.serviceResourceId,
    health: fabric.properties?.health,
    provisioningState: fabric.properties?.provisioningState,
    customProperties: custom,
    tags: userTags(fabric.tags),
  };
};

export const FabricProvider = () =>
  Provider.succeed(Fabric, {
    stables: ["fabricName", "resourceGroup", "fabricId", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* orUndefinedIfNotFound(
        dr
          .ListFabricBySubscription({ subscriptionId })
          .pipe(
            Effect.flatMap((page) =>
              requireSinglePage("ListFabricBySubscription", page),
            ),
          ),
      );
      return (page?.value ?? []).flatMap((fabric) => {
        const group = resourceGroupOf(fabric.id);
        return hasAnyAlchemyTag(fabric.tags) &&
          group !== undefined &&
          fabric.name !== undefined
          ? [toAttrs(group, fabric.name, fabric)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && !sameName(news.name, output.fabricName)) ||
        (news.location !== undefined &&
          !sameName(news.location, output.location)) ||
        (output.instanceType !== undefined &&
          !sameName(news.customProperties.instanceType, output.instanceType))
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
        output?.fabricName ??
        olds?.name ??
        (yield* createDataReplicationName(id));
      const observed = yield* getFabric({
        subscriptionId,
        resourceGroupName: resourceGroup,
        fabricName: name,
      });
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, DATA_REPLICATION_NAMESPACE);
      const name =
        news.name ??
        output?.fabricName ??
        (yield* createDataReplicationName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where: Where = {
        subscriptionId,
        resourceGroupName: news.resourceGroup,
        fabricName: name,
      };
      const get = getFabric(where);
      const converged = (fabric: Observed) =>
        !tagsDiffer(fabric.tags, tags) &&
        matchesDesired(customOf(fabric), news.customProperties);
      const settle = waitForProvisioned(
        `data replication fabric ${name}`,
        get,
        (fabric) =>
          converged(fabric) ? fabric.properties?.provisioningState : "Updating",
        { interval: "10 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* dr.CreateFabric({
          ...where,
          location,
          tags,
          properties: { customProperties: news.customProperties },
        });
        observed = yield* settle;
      }

      // Sync tags and settings against observed state in one PATCH.
      if (!converged(observed)) {
        yield* dr.UpdateFabric({
          ...where,
          tags,
          properties: { customProperties: news.customProperties },
        });
        observed = yield* settle;
      }

      return toAttrs(news.resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where: Where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        fabricName: output.fabricName,
      };
      yield* ignoreNotFound(dr.DeleteFabric(where));
      yield* waitUntilGone(
        `data replication fabric ${output.fabricName}`,
        getFabric(where),
        { interval: "10 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
