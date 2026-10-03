import * as ml from "@distilled.cloud/azure/machinelearningservices";
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
  createWorkspaceName,
  identityDiffers,
  type MachineLearningIdentity,
  sameArm,
  toArmIdentity,
} from "./Common.ts";

export interface RegistryRegion {
  /** Azure region the registry replicates to. */
  location: string;
  /**
   * SKU of the system-created container registry in this region.
   * @default "Premium"
   */
  acrSku?: "Premium";
  /**
   * Replication type of the system-created storage account.
   * @default "Standard_LRS"
   */
  storageAccountType?: string;
  /**
   * Create the storage account with a hierarchical namespace.
   * @default false
   */
  storageAccountHnsEnabled?: boolean;
}

export interface RegistryProps {
  /** Resource group the registry is created in. Changing it replaces the registry. */
  resourceGroup: string;
  /**
   * Registry name: 3-33 letters, digits, `-`, and `_`. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the registry.
   */
  name?: string;
  /**
   * Primary Azure location. Changing it replaces the registry.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Regions the registry replicates assets to (the primary location must
   * be included). Adding regions is in place; removing one replaces the
   * registry.
   * @default [{ location }]
   */
  regions?: RegistryRegion[];
  /**
   * Whether the registry accepts public traffic.
   * @default "Enabled"
   */
  publicNetworkAccess?: "Enabled" | "Disabled";
  /**
   * Managed identity of the registry.
   * @default { type: "SystemAssigned" }
   */
  identity?: MachineLearningIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Registry extends Resource<
  "Azure.MachineLearning.Registry",
  RegistryProps,
  {
    /** Name of the registry. */
    registryName: string;
    /** ARM resource ID of the registry. */
    registryId: string;
    /** Resource group that holds the registry. */
    resourceGroup: string;
    /** Primary location of the registry. */
    location: string;
    /** Locations the registry replicates to. */
    regions: string[];
    /** Discovery URL of the registry's API endpoints. */
    discoveryUrl: string | undefined;
    /** MLflow registry URI. */
    mlFlowRegistryUri: string | undefined;
    /** ARM ID of the managed resource group Azure creates for the registry. */
    managedResourceGroup: string | undefined;
    /** Principal ID of the system-assigned identity, if any. */
    principalId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Machine Learning registry — a cross-workspace catalog that
 * shares models, environments, components, and data across workspaces and
 * regions. Azure provisions a managed resource group with a Premium
 * container registry and a storage account per replicated region.
 *
 * @see https://learn.microsoft.com/azure/machine-learning/how-to-manage-registries
 *
 * ### Creating a Registry
 * **Example:** Single-region registry
 * ```typescript
 * const registry = yield* Azure.MachineLearning.Registry("shared", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * **Example:** Registry replicated to two regions
 * ```typescript
 * const registry = yield* Azure.MachineLearning.Registry("shared", {
 *   resourceGroup: group.resourceGroupName,
 *   location: "eastus",
 *   regions: [{ location: "eastus" }, { location: "westus2" }],
 * });
 * ```
 *
 * @resource
 */
export const Registry = Resource<Registry>("Azure.MachineLearning.Registry");

type ObservedRegistry = ml.Registry;

const getRegistry = (
  subscriptionId: string,
  resourceGroupName: string,
  registryName: string,
) =>
  orUndefinedIfNotFound(
    ml.GetRegistry({ subscriptionId, resourceGroupName, registryName }),
  );

const regionsOf = (registry: ObservedRegistry) =>
  (registry.properties.regionDetails ?? []).flatMap((region) =>
    region.location ? [region.location] : [],
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  registry: ObservedRegistry,
): Registry["Attributes"] => ({
  registryName: name,
  registryId: registry.id ?? "",
  resourceGroup,
  location: registry.location,
  regions: regionsOf(registry),
  discoveryUrl: registry.properties.discoveryUrl ?? undefined,
  mlFlowRegistryUri: registry.properties.mlFlowRegistryUri ?? undefined,
  managedResourceGroup:
    registry.properties.managedResourceGroup?.resourceId ?? undefined,
  principalId: registry.identity?.principalId,
  tags: userTags(registry.tags),
});

const toRegionDetails = (regions: RegistryRegion[]) =>
  regions.map((region) => ({
    location: region.location,
    acrDetails: [
      {
        systemCreatedAcrAccount: { acrAccountSku: region.acrSku ?? "Premium" },
      },
    ],
    storageAccountDetails: [
      {
        systemCreatedStorageAccount: {
          storageAccountType: region.storageAccountType ?? "Standard_LRS",
          storageAccountHnsEnabled: region.storageAccountHnsEnabled ?? false,
          allowBlobPublicAccess: false,
        },
      },
    ],
  }));

const missingRegions = (observed: string[], desired: RegistryRegion[]) =>
  desired.filter(
    (region) =>
      !observed.some((location) => sameArm(location, region.location)),
  );

export const RegistryProvider = () =>
  Provider.succeed(Registry, {
    stables: [
      "registryName",
      "registryId",
      "resourceGroup",
      "location",
      "managedResourceGroup",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* ml
        .ListRegistryBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListRegistryBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((registry) => {
        const group = resourceGroupOf(registry.id);
        return hasAnyAlchemyTag(registry.tags) &&
          group !== undefined &&
          registry.name !== undefined
          ? [toAttrs(group, registry.name, registry)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const desiredRegions = (news.regions ?? []).map((r) => r.location);
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && !sameArm(news.name, output.registryName)) ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location)) ||
        (news.regions !== undefined &&
          output.regions.some(
            (location) => !desiredRegions.some((d) => sameArm(d, location)),
          ))
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
        output?.registryName ?? olds?.name ?? (yield* createWorkspaceName(id));
      const observed = yield* getRegistry(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(
        subscriptionId,
        "Microsoft.MachineLearningServices",
      );
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.registryName ?? (yield* createWorkspaceName(id));
      const location = news.location ?? output?.location ?? env.location;
      const regions = news.regions ?? [{ location }];
      const tags = yield* desiredTags(id, news.tags);
      const identity = news.identity ?? { type: "SystemAssigned" as const };
      const publicNetworkAccess = news.publicNetworkAccess ?? "Enabled";
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        registryName: name,
      };
      const get = getRegistry(subscriptionId, resourceGroup, name);
      const label = `machine learning registry ${name}`;
      const converged = (registry: ObservedRegistry) =>
        missingRegions(regionsOf(registry), regions).length === 0 &&
        sameArm(
          registry.properties.publicNetworkAccess ?? "Enabled",
          publicNetworkAccess,
        ) &&
        !tagsDiffer(registry.tags, tags) &&
        !identityDiffers(registry.identity, identity);
      const waitConverged = waitForProvisioned(
        label,
        get,
        (registry) => (converged(registry) ? "Succeeded" : "Updating"),
        { interval: "10 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure. Creation provisions a managed resource group with a
      // container registry and storage account (long-running).
      if (observed === undefined) {
        yield* ml.RegistriesCreateOrUpdate({
          ...where,
          location,
          tags,
          identity: toArmIdentity(identity),
          properties: {
            regionDetails: toRegionDetails(regions),
            publicNetworkAccess,
          },
        });
        observed = yield* waitConverged;
      }

      // Sync replicated regions and network access (PUT of the whole
      // registry, keeping the observed region details).
      if (
        missingRegions(regionsOf(observed), regions).length > 0 ||
        !sameArm(
          observed.properties.publicNetworkAccess ?? "Enabled",
          publicNetworkAccess,
        )
      ) {
        yield* ml.RegistriesCreateOrUpdate({
          ...where,
          location: observed.location,
          tags,
          identity: toArmIdentity(identity),
          properties: {
            regionDetails: [
              ...(observed.properties.regionDetails ?? []),
              ...toRegionDetails(missingRegions(regionsOf(observed), regions)),
            ],
            publicNetworkAccess,
          },
        });
        observed = yield* waitConverged;
      }

      // Sync tags and identity (PATCH).
      if (
        tagsDiffer(observed.tags, tags) ||
        identityDiffers(observed.identity, identity)
      ) {
        yield* ml.UpdateRegistry({
          ...where,
          tags,
          identity: toArmIdentity(identity),
        });
        observed = yield* waitConverged;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        ml.DeleteRegistry({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          registryName: output.registryName,
        }),
      );
      yield* waitUntilGone(
        `machine learning registry ${output.registryName}`,
        getRegistry(subscriptionId, output.resourceGroup, output.registryName),
        { interval: "10 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
