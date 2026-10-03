import * as workloads from "@distilled.cloud/azure/workloads";
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
  identityBlock,
  identityIds,
  lower,
  withRecordedError,
} from "./Common.ts";

/** Register an existing SAP system with Azure Center for SAP solutions. */
export interface SapDiscoveryConfiguration {
  configurationType: "Discovery";
  /** ARM ID of the VM running the system's ABAP central services. */
  centralServerVmId: string;
  /** Custom name of the storage account created in the managed resource group. */
  managedRgStorageAccountName?: string;
}

/** Deploy SAP infrastructure (and optionally install SAP software). */
export interface SapDeploymentConfiguration {
  configurationType: "Deployment" | "DeploymentWithOSConfig";
  /** Region the SAP system is deployed to. */
  appLocation: string;
  /**
   * Infrastructure configuration (`SingleServer` or `ThreeTier`), in the
   * ARM wire format of `infrastructureConfiguration`.
   */
  infrastructureConfiguration: Record<string, unknown>;
  /**
   * Software configuration (`SAPInstallWithoutOSConfig`, `External`,
   * `ServiceInitiated`), in the ARM wire format of `softwareConfiguration`.
   */
  softwareConfiguration?: Record<string, unknown>;
  /** OS and SAP configuration, for `DeploymentWithOSConfig`. */
  osSapConfiguration?: Record<string, unknown>;
}

/** How the Virtual Instance for SAP solutions is created. */
export type SapVirtualInstanceConfiguration =
  | SapDiscoveryConfiguration
  | SapDeploymentConfiguration;

export interface SapVirtualInstanceProps {
  /** Resource group of the instance. Changing it replaces the instance. */
  resourceGroup: string;
  /**
   * SAP system ID (SID): three characters, an uppercase letter followed by
   * uppercase letters or digits, e.g. `S4H`. For `Discovery` it must match
   * the SID of the registered system. Changing it replaces the instance.
   */
  name: string;
  /**
   * Azure location of the instance. Changing it replaces the instance.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /** Environment type. Changing it replaces the instance. */
  environment: "NonProd" | "Prod";
  /** SAP product. Changing it replaces the instance. */
  sapProduct: "ECC" | "S4HANA" | "Other";
  /**
   * Deploy a new system or register an existing one. Changing it replaces
   * the instance.
   */
  configuration: SapVirtualInstanceConfiguration;
  /**
   * Name of the managed resource group Azure creates for the instance's
   * managed resources. Changing it replaces the instance.
   * @default chosen by Azure
   */
  managedResourceGroupName?: string;
  /**
   * Network access to the managed resources (the storage account).
   * @default Azure's default (`Public`)
   */
  managedResourcesNetworkAccessType?: "Public" | "Private";
  /**
   * ARM IDs of user-assigned identities with access to the SAP VMs. Azure
   * Center for SAP solutions uses them to discover and manage the system.
   * @default no identity
   */
  userAssignedIdentityIds?: string[];
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface SapVirtualInstance extends Resource<
  "Azure.Workloads.SapVirtualInstance",
  SapVirtualInstanceProps,
  {
    /** SAP system ID (name of the instance). */
    sapVirtualInstanceName: string;
    /** ARM resource ID of the instance. */
    sapVirtualInstanceId: string;
    /** Resource group that holds the instance. */
    resourceGroup: string;
    /** Location of the instance. */
    location: string;
    /** Environment type. */
    environment: string;
    /** SAP product. */
    sapProduct: string;
    /** Configuration type (`Discovery`, `Deployment`, `DeploymentWithOSConfig`). */
    configurationType: string;
    /** Name of the managed resource group. */
    managedResourceGroupName: string | undefined;
    /** Network access to the managed resources. */
    managedResourcesNetworkAccessType: string | undefined;
    /** ARM IDs of the user-assigned identities on the instance. */
    userAssignedIdentityIds: string[];
    /** Run status of the SAP system, e.g. `Running`. */
    status: string | undefined;
    /** Health of the SAP system, e.g. `Healthy`. */
    health: string | undefined;
    /** Lifecycle state, e.g. `RegistrationComplete`. */
    state: string | undefined;
    /** Provisioning state of the instance. */
    provisioningState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A Virtual Instance for SAP solutions (VIS) — the Azure Center for SAP
 * solutions representation of an SAP system. Either register an existing
 * system running on Azure VMs (`Discovery`), or have Azure deploy the
 * infrastructure and optionally install SAP software (`Deployment`).
 *
 * Deleting the instance removes the VIS and its child instance resources,
 * not the underlying VMs. Registration takes several minutes; reconcile
 * waits up to 30 minutes for the instance to finish provisioning, so long
 * software deployments should be driven outside a single deploy.
 *
 * @see https://learn.microsoft.com/azure/sap/center-sap-solutions/overview
 *
 * ### Registering an Existing System
 * **Example:** Discover an SAP system by its central services VM
 * ```typescript
 * const vis = yield* Azure.Workloads.SapVirtualInstance("s4h", {
 *   resourceGroup: group.resourceGroupName,
 *   name: "S4H",
 *   environment: "NonProd",
 *   sapProduct: "S4HANA",
 *   configuration: {
 *     configurationType: "Discovery",
 *     centralServerVmId: ascsVm.vmId,
 *   },
 *   userAssignedIdentityIds: [identity.identityId],
 * });
 * ```
 *
 * ### Deploying Infrastructure
 * **Example:** Single-server infrastructure deployment
 * ```typescript
 * const vis = yield* Azure.Workloads.SapVirtualInstance("x01", {
 *   resourceGroup: group.resourceGroupName,
 *   name: "X01",
 *   environment: "NonProd",
 *   sapProduct: "S4HANA",
 *   configuration: {
 *     configurationType: "Deployment",
 *     appLocation: "eastus",
 *     infrastructureConfiguration: {
 *       deploymentType: "SingleServer",
 *       appResourceGroup: group.resourceGroupName,
 *       virtualMachineConfiguration: vmConfiguration,
 *       subnetId: subnet.subnetId,
 *     },
 *   },
 * });
 * ```
 *
 * @resource
 */
export const SapVirtualInstance = Resource<SapVirtualInstance>(
  "Azure.Workloads.SapVirtualInstance",
);

type Observed = workloads.GetSapVirtualInstanceResponse;

const getInstance = (
  subscriptionId: string,
  resourceGroupName: string,
  sapVirtualInstanceName: string,
) =>
  orUndefinedIfNotFound(
    workloads.GetSapVirtualInstance({
      subscriptionId,
      resourceGroupName,
      sapVirtualInstanceName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: Observed,
): SapVirtualInstance["Attributes"] => {
  const props = observed.properties;
  return {
    sapVirtualInstanceName: name,
    sapVirtualInstanceId: observed.id ?? "",
    resourceGroup,
    location: observed.location,
    environment: props?.environment ?? "",
    sapProduct: props?.sapProduct ?? "",
    configurationType: props?.configuration?.configurationType ?? "",
    managedResourceGroupName: props?.managedResourceGroupConfiguration?.name,
    managedResourcesNetworkAccessType: props?.managedResourcesNetworkAccessType,
    userAssignedIdentityIds: Object.keys(
      observed.identity?.userAssignedIdentities ?? {},
    ),
    status: props?.status,
    health: props?.health,
    state: props?.state,
    provisioningState: props?.provisioningState,
    tags: userTags(observed.tags),
  };
};

const describeErrors = (observed: Observed | undefined) => {
  const props = observed?.properties;
  const error = props?.errors?.properties;
  const detail = error
    ? [error.code, error.message?.trim()].filter(Boolean).join(": ")
    : undefined;
  return [props?.state, detail].filter(Boolean).join(" — ") || undefined;
};

/** Canonical JSON with sorted keys, for comparing configurations. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a.localeCompare(b),
          ),
        )
      : v,
  );

export const SapVirtualInstanceProvider = () =>
  Provider.succeed(SapVirtualInstance, {
    stables: [
      "sapVirtualInstanceName",
      "sapVirtualInstanceId",
      "resourceGroup",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* workloads
        .ListSapVirtualInstanceBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListSapVirtualInstanceBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((instance) => {
        const group = resourceGroupOf(instance.id);
        return hasAnyAlchemyTag(instance.tags) &&
          group !== undefined &&
          instance.name !== undefined
          ? [toAttrs(group, instance.name, instance)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        news.name !== output.sapVirtualInstanceName ||
        (news.location !== undefined &&
          lower(news.location) !== lower(output.location)) ||
        news.environment !== output.environment ||
        news.sapProduct !== output.sapProduct ||
        news.configuration.configurationType !== output.configurationType ||
        (news.managedResourceGroupName !== undefined &&
          lower(news.managedResourceGroupName) !==
            lower(output.managedResourceGroupName)) ||
        (olds !== undefined &&
          canonical(news.configuration) !== canonical(olds.configuration))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const name = output?.sapVirtualInstanceName ?? olds?.name;
      if (resourceGroup === undefined || name === undefined) return undefined;
      const observed = yield* getInstance(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Workloads");
      const resourceGroup = news.resourceGroup;
      const name = news.name;
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const identity = identityBlock(news.userAssignedIdentityIds);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        sapVirtualInstanceName: name,
      };
      const get = getInstance(subscriptionId, resourceGroup, name);
      // Discovery takes a few minutes; infrastructure deployment much
      // longer. Wait up to 30 minutes.
      const waitReady = waitForProvisioned(
        `Virtual Instance for SAP solutions ${name}`,
        get,
        (observed) => observed.properties?.provisioningState,
        { interval: "30 seconds", times: 60 },
      ).pipe(withRecordedError(Effect.map(get, describeErrors)));

      // Observe.
      let observed = yield* get;

      // Ensure. A failed registration/deployment is re-submitted.
      if (
        observed === undefined ||
        observed.properties?.provisioningState === "Failed"
      ) {
        yield* workloads.CreateSapVirtualInstance({
          ...where,
          location,
          tags,
          identity: news.userAssignedIdentityIds?.length ? identity : undefined,
          properties: {
            environment: news.environment,
            sapProduct: news.sapProduct,
            managedResourcesNetworkAccessType:
              news.managedResourcesNetworkAccessType,
            managedResourceGroupConfiguration:
              news.managedResourceGroupName !== undefined
                ? { name: news.managedResourceGroupName }
                : undefined,
            configuration: news.configuration,
          },
        });
      }
      observed = yield* waitReady;

      // Sync tags, identity, and managed-resource network access.
      const tagsChanged = tagsDiffer(observed.tags, tags);
      const identityChanged =
        identityIds(
          Object.keys(observed.identity?.userAssignedIdentities ?? {}),
        ).join(",") !== identityIds(news.userAssignedIdentityIds).join(",");
      const accessChanged =
        news.managedResourcesNetworkAccessType !== undefined &&
        news.managedResourcesNetworkAccessType !==
          observed.properties?.managedResourcesNetworkAccessType;
      if (tagsChanged || identityChanged || accessChanged) {
        yield* workloads.UpdateSapVirtualInstance({
          ...where,
          tags: tagsChanged ? tags : undefined,
          identity: identityChanged ? identity : undefined,
          properties: accessChanged
            ? {
                managedResourcesNetworkAccessType:
                  news.managedResourcesNetworkAccessType,
              }
            : undefined,
        });
        observed = yield* waitReady;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        workloads.DeleteSapVirtualInstance({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          sapVirtualInstanceName: output.sapVirtualInstanceName,
        }),
      );
      yield* waitUntilGone(
        `Virtual Instance for SAP solutions ${output.sapVirtualInstanceName}`,
        getInstance(
          subscriptionId,
          output.resourceGroup,
          output.sapVirtualInstanceName,
        ),
        { interval: "10 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
