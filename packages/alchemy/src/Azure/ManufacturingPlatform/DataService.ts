import * as mds from "@distilled.cloud/azure/manufacturingplatform";
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

/** Managed identity type of a Manufacturing Data Solutions service. */
export type DataServiceIdentityType =
  | "None"
  | "SystemAssigned"
  | "UserAssigned"
  | "SystemAssigned,UserAssigned";

export interface DataServiceIdentity {
  /** Identity type. `None` removes all identities. */
  type: DataServiceIdentityType;
  /**
   * ARM resource IDs of user-assigned identities to attach (required when
   * `type` includes `UserAssigned`).
   */
  userAssignedIdentities?: string[];
}

export interface DataServiceSku {
  /** SKU name, e.g. `Standard`. */
  name: string;
  /** SKU tier. */
  tier?: "Free" | "Basic" | "Standard" | "Premium";
  /** SKU size code. */
  size?: string;
  /** Hardware family. */
  family?: string;
  /** Scale-out capacity. */
  capacity?: number;
}

export interface DataServiceOpenAIProfile {
  /** GPT model name, e.g. `gpt-4o`. */
  gptModelName?: string;
  /** GPT model version. */
  gptModelVersion?: string;
  /** GPT deployment capacity (thousands of tokens per minute). */
  gptModelCapacity?: number;
  /** GPT deployment SKU name, e.g. `Standard`. */
  gptModelSkuName?: string;
  /** Embedding model name, e.g. `text-embedding-ada-002`. */
  embeddingModelName?: string;
  /** Embedding model version. */
  embeddingModelVersion?: string;
  /** Embedding deployment SKU name. */
  embeddingModelSkuName?: string;
  /** Embedding deployment capacity. */
  embeddingModelCapacity?: number;
}

export interface DataServiceUserManagedOpenAIProfile {
  /** ARM resource ID of an existing Azure OpenAI account. */
  id: string;
  /** Name of the GPT model deployment on that account. */
  gptModelDeploymentName: string;
  /** Name of the embedding model deployment on that account. */
  embeddingModelDeploymentName: string;
}

export interface DataServiceFabricProfile {
  /** Azure Key Vault URI holding the Fabric credentials. */
  keyUri: string;
  /** OneLake URI. */
  oneLakeUri: string;
  /** OneLake path. */
  oneLakePath: string;
}

export interface DataServiceDenyAssignmentExclusion {
  /** Object ID of the excluded identity. */
  id: string;
  /** Type of the excluded identity, e.g. `User` or `ServicePrincipal`. */
  type: string;
}

export interface DataServiceProps {
  /**
   * Resource group the service is created in. Changing it replaces the
   * service.
   */
  resourceGroup: string;
  /**
   * Name of the service, 3-23 letters, digits, and hyphens. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the service.
   */
  name?: string;
  /**
   * Azure location of the service. Changing it replaces the service.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Client ID of the Microsoft Entra application used to sign in to the
   * service. Changing it replaces the service.
   */
  aadApplicationId: string;
  /**
   * Object ID of the Entra group granted admin on the managed AKS cluster.
   * Azure cannot change it in place, so changing it replaces the service.
   */
  aksAdminGroupId?: string;
  /** SKU. Updated in place when it changes. */
  sku?: DataServiceSku;
  /** Manufacturing Data Solutions release version. Raising it upgrades in place. */
  version?: string;
  /** Enable the Copilot experience. */
  enableCopilot?: boolean;
  /** Send diagnostic settings of the managed resources to monitoring. */
  enableDiagnosticSettings?: boolean;
  /** Model deployments of the service-managed Azure OpenAI account. */
  openAIProfile?: DataServiceOpenAIProfile;
  /** Use an existing (user-managed) Azure OpenAI account instead. */
  userManagedOpenAIProfile?: DataServiceUserManagedOpenAIProfile;
  /**
   * Azure Key Vault key URI for customer-managed-key encryption. Changing it
   * replaces the service.
   */
  cmkKeyUri?: string;
  /** Microsoft Fabric (OneLake) integration. */
  fabricProfile?: DataServiceFabricProfile;
  /** Identities excluded from the managed resource group's deny assignment. */
  denyAssignmentExclusions?: DataServiceDenyAssignmentExclusion[];
  /** `Inactive` stops the service; `Active` starts it. Not managed when omitted. */
  resourceState?: "Active" | "Inactive";
  /**
   * Zone redundancy of the managed resources. Changing it replaces the
   * service.
   */
  redundancyState?: "Zonal" | "None";
  /** Managed identity of the service. Not managed when omitted. */
  identity?: DataServiceIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface DataService extends Resource<
  "Azure.ManufacturingPlatform.DataService",
  DataServiceProps,
  {
    /** Name of the service. */
    dataServiceName: string;
    /** ARM resource ID of the service. */
    dataServiceId: string;
    /** Resource group that holds the service. */
    resourceGroup: string;
    /** Location of the service. */
    location: string;
    /** Entra application client ID. */
    aadApplicationId: string;
    /** AKS admin group object ID, if set. */
    aksAdminGroupId: string | undefined;
    /** Customer-managed key URI, if set. */
    cmkKeyUri: string | undefined;
    /** Zone redundancy state as Azure reports it. */
    redundancyState: string | undefined;
    /** Installed release version. */
    version: string | undefined;
    /** Run state, `Active` or `Inactive`. */
    resourceState: string | undefined;
    /** Service URL of the deployed solution. */
    serviceUrl: string | undefined;
    /** Name of the managed resource group holding the service's resources. */
    managedResourceGroup: string | undefined;
    /** Principal ID of the system-assigned identity, if any. */
    principalId: string | undefined;
    /** ARM provisioning state. */
    provisioningState: string;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Manufacturing Data Solutions service — a managed data platform
 * (AKS, Azure Data Explorer, Cosmos DB, Event Hubs, Azure OpenAI) for
 * industrial data with a Copilot experience. Provisioning takes about an
 * hour and deploys a large, billed footprint into a managed resource group.
 *
 * @see https://learn.microsoft.com/azure/manufacturing-data-solutions/
 *
 * ### Creating a Data Service
 * **Example:** Minimal service signed in through an Entra application
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("mds");
 * const service = yield* Azure.ManufacturingPlatform.DataService("mds", {
 *   resourceGroup: group.resourceGroupName,
 *   aadApplicationId: "00000000-0000-0000-0000-000000000000",
 *   aksAdminGroupId: "11111111-1111-1111-1111-111111111111",
 * });
 * ```
 *
 * ### Configuring Copilot
 * **Example:** Copilot with service-managed OpenAI deployments
 * ```typescript
 * const service = yield* Azure.ManufacturingPlatform.DataService("mds", {
 *   resourceGroup: group.resourceGroupName,
 *   aadApplicationId: appId,
 *   enableCopilot: true,
 *   openAIProfile: {
 *     gptModelName: "gpt-4o",
 *     gptModelCapacity: 50,
 *     embeddingModelName: "text-embedding-ada-002",
 *     embeddingModelCapacity: 50,
 *   },
 * });
 * ```
 *
 * ### Stopping a Data Service
 * **Example:** Mark the service inactive
 * ```typescript
 * const service = yield* Azure.ManufacturingPlatform.DataService("mds", {
 *   resourceGroup: group.resourceGroupName,
 *   aadApplicationId: appId,
 *   resourceState: "Inactive",
 * });
 * ```
 *
 * @resource
 */
export const DataService = Resource<DataService>(
  "Azure.ManufacturingPlatform.DataService",
);

type Observed = mds.GetManufacturingDataServiceResponse;

const NAME_MAX = 23;

const createServiceName = Effect.fn(function* (id: string) {
  const name = (yield* createPhysicalName({
    id,
    maxLength: NAME_MAX,
    lowercase: true,
    delimiter: "-",
  })).replace(/[^a-z0-9-]/g, "");
  return name.length >= 3 ? name : `mds${name}`.slice(0, NAME_MAX);
});

const getService = (
  subscriptionId: string,
  resourceGroupName: string,
  mdsResourceName: string,
) =>
  orUndefinedIfNotFound(
    mds.GetManufacturingDataService({
      subscriptionId,
      resourceGroupName,
      mdsResourceName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: Observed,
): DataService["Attributes"] => ({
  dataServiceName: name,
  dataServiceId: observed.id ?? "",
  resourceGroup,
  location: observed.location,
  aadApplicationId: observed.properties?.aadApplicationId ?? "",
  aksAdminGroupId: observed.properties?.aksAdminGroupId,
  cmkKeyUri: observed.properties?.cmkProfile?.keyUri,
  redundancyState: observed.properties?.redundancyState,
  version: observed.properties?.version,
  resourceState: observed.properties?.resourceState,
  serviceUrl: observed.properties?.serviceUrl,
  managedResourceGroup:
    observed.properties?.managedResourceGroupConfiguration?.name,
  principalId: observed.identity?.principalId,
  provisioningState: observed.properties?.provisioningState ?? "",
  tags: userTags(observed.tags),
});

const lower = (s: string | undefined) => s?.toLowerCase();
const normLocation = (s: string | undefined) =>
  s?.replace(/\s/g, "").toLowerCase();

/** True when any field set in `desired` differs from `observed`. */
const fieldsDiffer = (
  desired: object | undefined,
  observed: object | undefined,
) =>
  desired !== undefined &&
  Object.entries(desired).some(
    ([k, v]) =>
      v !== undefined &&
      (observed as Record<string, unknown> | undefined)?.[k] !== v,
  );

const sameExclusions = (
  a: readonly DataServiceDenyAssignmentExclusion[],
  b: readonly DataServiceDenyAssignmentExclusion[],
) => {
  const norm = (xs: readonly DataServiceDenyAssignmentExclusion[]) =>
    xs.map((x) => `${x.id.toLowerCase()}|${x.type.toLowerCase()}`).sort();
  const x = norm(a);
  const y = norm(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

const identityDiffers = (
  desired: DataServiceIdentity | undefined,
  observed: Observed["identity"],
) => {
  if (desired === undefined) return false;
  const observedType = (observed?.type ?? "None").replace(/\s/g, "");
  if (observedType.toLowerCase() !== desired.type.toLowerCase()) return true;
  const want = (desired.userAssignedIdentities ?? [])
    .map((x) => x.toLowerCase())
    .sort();
  const have = Object.keys(observed?.userAssignedIdentities ?? {})
    .map((x) => x.toLowerCase())
    .sort();
  return want.length !== have.length || want.some((v, i) => v !== have[i]);
};

const identityInput = (identity: DataServiceIdentity) => ({
  type: identity.type,
  ...(identity.userAssignedIdentities?.length
    ? {
        userAssignedIdentities: Object.fromEntries(
          identity.userAssignedIdentities.map((x) => [x, {}]),
        ),
      }
    : {}),
});

// Creation deploys AKS, ADX, Cosmos DB and OpenAI: ~1 hour.
const BUDGET = { interval: "60 seconds", times: 60 } as const;

export const DataServiceProvider = () =>
  Provider.succeed(DataService, {
    stables: ["dataServiceName", "dataServiceId", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* mds
        .ListManufacturingDataServiceBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage(
              "ListManufacturingDataServiceBySubscription",
              page,
            ),
          ),
          // An unregistered subscription, or one the (allow-listed) namespace
          // is not available to, cannot hold services.
          Effect.catchTag(
            ["MissingRegistration", "InvalidResourceNamespace"],
            () => Effect.succeed({ value: [] as mds.MdsResource[] }),
          ),
        );
      return (page.value ?? []).flatMap((service) => {
        const group = resourceGroupOf(service.id);
        return hasAnyAlchemyTag(service.tags) &&
          group !== undefined &&
          service.name !== undefined
          ? [toAttrs(group, service.name, service)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.dataServiceName)) ||
        (news.location !== undefined &&
          normLocation(news.location) !== normLocation(output.location)) ||
        lower(news.aadApplicationId) !== lower(output.aadApplicationId) ||
        (news.aksAdminGroupId !== undefined &&
          lower(news.aksAdminGroupId) !== lower(output.aksAdminGroupId)) ||
        (news.cmkKeyUri !== undefined && news.cmkKeyUri !== output.cmkKeyUri) ||
        (news.redundancyState !== undefined &&
          output.redundancyState !== undefined &&
          news.redundancyState !== output.redundancyState)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (typeof resourceGroup !== "string") return undefined;
      const name =
        output?.dataServiceName ??
        (typeof olds?.name === "string"
          ? olds.name
          : yield* createServiceName(id));
      const observed = yield* getService(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(
        subscriptionId,
        "Microsoft.ManufacturingPlatform",
      );
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.dataServiceName ?? (yield* createServiceName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const ref = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        mdsResourceName: name,
      };
      const settle = waitForProvisioned(
        `Manufacturing data service ${name}`,
        getService(subscriptionId, resourceGroup, name),
        (s) => s.properties?.provisioningState,
        BUDGET,
      );

      // Observe.
      let observed = yield* getService(subscriptionId, resourceGroup, name);

      // Ensure.
      if (observed === undefined) {
        yield* mds.ManufacturingDataServicesCreateOrUpdate({
          ...ref,
          location,
          tags,
          ...(news.sku ? { sku: news.sku } : {}),
          ...(news.identity ? { identity: identityInput(news.identity) } : {}),
          properties: {
            aadApplicationId: news.aadApplicationId,
            aksAdminGroupId: news.aksAdminGroupId,
            version: news.version,
            enableCopilot: news.enableCopilot,
            enableDiagnosticSettings: news.enableDiagnosticSettings,
            openAIProfile: news.openAIProfile,
            userManagedOpenAIProfile: news.userManagedOpenAIProfile,
            cmkProfile:
              news.cmkKeyUri !== undefined
                ? { keyUri: news.cmkKeyUri }
                : undefined,
            fabricProfile: news.fabricProfile,
            denyAssignmentExclusions: news.denyAssignmentExclusions,
            resourceState: news.resourceState,
            redundancyState: news.redundancyState,
          },
        });
      }
      observed = yield* settle;

      // Sync each mutable aspect against observed state; PATCH only deltas.
      const props = observed.properties;
      const properties: mds.MdsResourceUpdatePropertiesInput = {
        ...(news.version !== undefined && props?.version !== news.version
          ? { version: news.version }
          : {}),
        ...(news.enableCopilot !== undefined &&
        props?.enableCopilot !== news.enableCopilot
          ? { enableCopilot: news.enableCopilot }
          : {}),
        ...(news.enableDiagnosticSettings !== undefined &&
        props?.enableDiagnosticSettings !== news.enableDiagnosticSettings
          ? { enableDiagnosticSettings: news.enableDiagnosticSettings }
          : {}),
        ...(fieldsDiffer(news.openAIProfile, props?.openAIProfile)
          ? { openAIProfile: news.openAIProfile }
          : {}),
        ...(fieldsDiffer(
          news.userManagedOpenAIProfile,
          props?.userManagedOpenAIProfile,
        )
          ? { userManagedOpenAIProfile: news.userManagedOpenAIProfile }
          : {}),
        ...(fieldsDiffer(news.fabricProfile, props?.fabricProfile)
          ? { fabricProfile: news.fabricProfile }
          : {}),
        ...(news.denyAssignmentExclusions !== undefined &&
        !sameExclusions(
          news.denyAssignmentExclusions,
          props?.denyAssignmentExclusions ?? [],
        )
          ? { denyAssignmentExclusions: news.denyAssignmentExclusions }
          : {}),
        ...(news.resourceState !== undefined &&
        props?.resourceState !== news.resourceState
          ? { resourceState: news.resourceState }
          : {}),
      };
      const skuChanged = fieldsDiffer(news.sku, observed.sku);
      const identityChanged = identityDiffers(news.identity, observed.identity);
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (
        Object.keys(properties).length > 0 ||
        skuChanged ||
        identityChanged ||
        tagsChanged
      ) {
        yield* mds.UpdateManufacturingDataService({
          ...ref,
          ...(Object.keys(properties).length > 0 ? { properties } : {}),
          ...(skuChanged ? { sku: news.sku } : {}),
          ...(identityChanged && news.identity
            ? { identity: identityInput(news.identity) }
            : {}),
          ...(tagsChanged ? { tags } : {}),
        });
        observed = yield* settle;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        mds.DeleteManufacturingDataService({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          mdsResourceName: output.dataServiceName,
        }),
      );
      yield* waitUntilGone(
        `Manufacturing data service ${output.dataServiceName}`,
        getService(
          subscriptionId,
          output.resourceGroup,
          output.dataServiceName,
        ),
        BUDGET,
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
