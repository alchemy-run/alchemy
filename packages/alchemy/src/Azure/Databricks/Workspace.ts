import * as databricks from "@distilled.cloud/azure/databricks";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
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

/** Access connector a workspace uses for its default storage. */
export interface WorkspaceAccessConnector {
  /** ARM resource ID of the `Azure.Databricks.AccessConnector`. */
  id: string;
  /** Which identity of the connector the workspace uses. */
  identityType: "SystemAssigned" | "UserAssigned";
  /**
   * ARM ID of the user-assigned identity to use. Required when
   * `identityType` is `UserAssigned`.
   */
  userAssignedIdentityId?: string;
}

export interface WorkspaceProps {
  /**
   * Resource group the workspace is created in. Changing it replaces the
   * workspace.
   */
  resourceGroup: string;
  /**
   * Name of the workspace, 3-64 characters of letters, digits, `-`, and
   * `_`. If omitted, a unique name is generated from the app, stage, and
   * logical ID. Changing it replaces the workspace.
   */
  name?: string;
  /**
   * Azure location of the workspace. Changing it replaces the workspace.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Compute mode. `Hybrid` runs classic clusters in a managed resource group
   * in your subscription; `Serverless` runs only Databricks-managed
   * serverless compute and requires the `premium` SKU. Changing it replaces
   * the workspace.
   * @default "Hybrid"
   */
  computeMode?: "Hybrid" | "Serverless";
  /**
   * Pricing tier. `standard` and `premium` can be switched in place;
   * `trial` is a 14-day premium trial.
   * @default "premium"
   */
  sku?: "standard" | "premium" | "trial";
  /**
   * Name of the managed resource group Azure Databricks creates (and locks
   * with a deny assignment) for the workspace's classic compute. It must not
   * exist yet. Hybrid only. Changing it replaces the workspace.
   * @default `databricks-rg-<workspace name>`
   */
  managedResourceGroupName?: string;
  /**
   * Secure cluster connectivity (no public IPs on cluster nodes). With a
   * managed VNet, Azure adds a NAT gateway and a public IP to the managed
   * resource group. Hybrid only.
   * @default true
   */
  enableNoPublicIp?: boolean;
  /**
   * ARM ID of your own virtual network to deploy clusters into (VNet
   * injection). Hybrid only. Changing it replaces the workspace.
   */
  customVirtualNetworkId?: string;
  /**
   * Name of the host (public) subnet in `customVirtualNetworkId`, delegated
   * to `Microsoft.Databricks/workspaces`.
   */
  customPublicSubnetName?: string;
  /**
   * Name of the container (private) subnet in `customVirtualNetworkId`,
   * delegated to `Microsoft.Databricks/workspaces`.
   */
  customPrivateSubnetName?: string;
  /**
   * Address prefix (first two octets, e.g. `10.139`) of the managed VNet.
   * Hybrid only. Changing it replaces the workspace.
   */
  vnetAddressPrefix?: string;
  /**
   * Name of the default DBFS storage account. Hybrid only. Changing it
   * replaces the workspace.
   */
  storageAccountName?: string;
  /**
   * SKU of the default DBFS storage account, e.g. `Standard_LRS`,
   * `Standard_GRS`. Hybrid only. Changing it replaces the workspace.
   */
  storageAccountSkuName?: string;
  /**
   * Enable double encryption (infrastructure encryption) on the DBFS root.
   * Hybrid only. Changing it replaces the workspace.
   */
  requireInfrastructureEncryption?: boolean;
  /**
   * Enable a managed identity on the DBFS storage account so a
   * customer-managed key can be configured later. Hybrid only.
   */
  prepareEncryption?: boolean;
  /**
   * Whether the workspace's web app and REST API are reachable from the
   * public internet. `Disabled` requires private endpoints.
   */
  publicNetworkAccess?: "Enabled" | "Disabled";
  /**
   * Which NSG rules Azure Databricks manages for back-end private link.
   * Hybrid only.
   */
  requiredNsgRules?: "AllRules" | "NoAzureDatabricksRules";
  /**
   * Initial default catalog type (`UnityCatalog` or `HiveMetastore`) and
   * name. Only applied at creation; changing it replaces the workspace.
   */
  defaultCatalog?: {
    initialType?: "HiveMetastore" | "UnityCatalog";
    initialName?: string;
  };
  /**
   * Access connector whose identity accesses the workspace's default
   * storage. Hybrid only.
   */
  accessConnector?: WorkspaceAccessConnector;
  /**
   * Firewall on the default storage account. `Enabled` requires
   * `accessConnector`. Hybrid only.
   */
  defaultStorageFirewall?: "Enabled" | "Disabled";
  /**
   * Customer-managed keys for managed services and managed disks (premium).
   */
  encryption?: databricks.WorkspacePropertiesEncryption;
  /**
   * Enhanced Security and Compliance add-on settings (premium; billed
   * separately).
   */
  enhancedSecurityCompliance?: databricks.EnhancedSecurityComplianceDefinition;
  /**
   * Delete Unity Catalog default data with the workspace instead of
   * retaining it.
   * @default false
   */
  forceDeletion?: boolean;
  /**
   * User tags, also propagated to the resources in the managed resource
   * group. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Workspace extends Resource<
  "Azure.Databricks.Workspace",
  WorkspaceProps,
  {
    /** Name of the workspace. */
    workspaceName: string;
    /** ARM resource ID of the workspace. */
    workspaceId: string;
    /** Resource group that holds the workspace. */
    resourceGroup: string;
    /** Location of the workspace. */
    location: string;
    /** Compute mode of the workspace. */
    computeMode: string;
    /** Pricing tier. */
    sku: string;
    /**
     * Workspace URL host, `adb-<id>.<n>.azuredatabricks.net`. Prefix with
     * `https://` for the web app and REST API.
     */
    workspaceUrl: string;
    /** Numeric workspace ID in the Databricks control plane. */
    workspaceNumericId: string;
    /** ARM ID of the managed resource group (Hybrid only). */
    managedResourceGroupId: string | undefined;
    /** Whether Unity Catalog is enabled. */
    isUcEnabled: boolean;
    /**
     * Principal ID of the DBFS storage account's managed identity (set when
     * `prepareEncryption` is enabled).
     */
    storageAccountPrincipalId: string | undefined;
    /** Principal ID of the managed disk encryption set identity. */
    managedDiskPrincipalId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Databricks workspace — the Databricks control-plane account plus
 * (in `Hybrid` mode) a locked managed resource group holding the DBFS
 * storage account and the cluster network. The workspace itself is free
 * until clusters or SQL warehouses run.
 *
 * Creation takes 3-6 minutes; deletion up to 15 minutes, after which Azure
 * removes the managed resource group.
 *
 * @see https://learn.microsoft.com/azure/databricks/getting-started/
 *
 * ### Creating a Workspace
 * **Example:** Premium workspace with a managed VNet
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("analytics");
 * const workspace = yield* Azure.Databricks.Workspace("lakehouse", {
 *   resourceGroup: group.resourceGroupName,
 *   sku: "premium",
 * });
 * // https://${workspace.workspaceUrl}
 * ```
 *
 * **Example:** Serverless workspace
 * ```typescript
 * const workspace = yield* Azure.Databricks.Workspace("serverless", {
 *   resourceGroup: group.resourceGroupName,
 *   computeMode: "Serverless",
 *   sku: "premium",
 * });
 * ```
 *
 * ### Networking
 * **Example:** VNet-injected workspace
 * ```typescript
 * const workspace = yield* Azure.Databricks.Workspace("injected", {
 *   resourceGroup: group.resourceGroupName,
 *   customVirtualNetworkId: vnet.virtualNetworkId,
 *   customPublicSubnetName: "databricks-host",
 *   customPrivateSubnetName: "databricks-container",
 * });
 * ```
 *
 * ### Unity Catalog Storage
 * **Example:** Default storage behind an access connector
 * ```typescript
 * const connector = yield* Azure.Databricks.AccessConnector("uc", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const workspace = yield* Azure.Databricks.Workspace("lakehouse", {
 *   resourceGroup: group.resourceGroupName,
 *   accessConnector: {
 *     id: connector.accessConnectorId,
 *     identityType: "SystemAssigned",
 *   },
 *   defaultStorageFirewall: "Enabled",
 * });
 * ```
 *
 * @resource
 */
export const Workspace = Resource<Workspace>("Azure.Databricks.Workspace");

type Observed = databricks.GetWorkspaceResponse;

const getWorkspace = (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
) =>
  orUndefinedIfNotFound(
    databricks.GetWorkspace({
      subscriptionId,
      resourceGroupName,
      workspaceName,
    }),
  );

const createName = (id: string) => createPhysicalName({ id, maxLength: 64 });

const managedGroupName = (props: WorkspaceProps, name: string) =>
  props.managedResourceGroupName ?? `databricks-rg-${name}`.slice(0, 90);

const toAttrs = (
  resourceGroup: string,
  name: string,
  workspace: Observed,
): Workspace["Attributes"] => ({
  workspaceName: name,
  workspaceId: workspace.id ?? "",
  resourceGroup,
  location: workspace.location,
  computeMode: workspace.properties.computeMode,
  sku: workspace.sku?.name ?? "",
  workspaceUrl: workspace.properties.workspaceUrl ?? "",
  workspaceNumericId: workspace.properties.workspaceId ?? "",
  managedResourceGroupId: workspace.properties.managedResourceGroupId,
  isUcEnabled: workspace.properties.isUcEnabled ?? false,
  storageAccountPrincipalId:
    workspace.properties.storageAccountIdentity?.principalId,
  managedDiskPrincipalId: workspace.properties.managedDiskIdentity?.principalId,
  tags: userTags(workspace.tags),
});

const lower = (value: string | undefined) => value?.toLowerCase();

/**
 * A workspace that is still provisioning, updating, or deleting rejects
 * writes and deletes with `DatabricksApplianceBusy`; wait it out. A delete
 * retried this way ends once the workspace is gone.
 */
const whileApplianceBusy = {
  while: (e: { readonly _tag: string }) => e._tag === "DatabricksApplianceBusy",
  schedule: Schedule.spaced("10 seconds"),
  times: 60,
} as const;

const str = (value: string | undefined) =>
  value === undefined ? undefined : { value };
const bool = (value: boolean | undefined) =>
  value === undefined ? undefined : { value };

/** Custom parameters the user asked for (Hybrid only). */
const desiredParameters = (
  news: WorkspaceProps,
): databricks.WorkspaceCustomParameters => ({
  customVirtualNetworkId: str(news.customVirtualNetworkId),
  customPublicSubnetName: str(news.customPublicSubnetName),
  customPrivateSubnetName: str(news.customPrivateSubnetName),
  enableNoPublicIp: bool(news.enableNoPublicIp ?? true),
  vnetAddressPrefix: str(news.vnetAddressPrefix),
  storageAccountName: str(news.storageAccountName),
  storageAccountSkuName: str(news.storageAccountSkuName),
  requireInfrastructureEncryption: bool(news.requireInfrastructureEncryption),
  prepareEncryption: bool(news.prepareEncryption),
});

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a.localeCompare(b),
          ),
        )
      : v,
  ) ?? "undefined";

/** Whether `desired` (when specified) differs from `observed`. */
const differs = (desired: unknown, observed: unknown) =>
  desired !== undefined && canonical(desired) !== canonical(observed);

export const WorkspaceProvider = () =>
  Provider.succeed(Workspace, {
    stables: [
      "workspaceName",
      "workspaceId",
      "resourceGroup",
      "location",
      "computeMode",
      "workspaceUrl",
      "workspaceNumericId",
      "managedResourceGroupId",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* databricks
        .ListWorkspaceBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListWorkspaceBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((workspace) => {
        const group = resourceGroupOf(workspace.id);
        return hasAnyAlchemyTag(workspace.tags) &&
          group !== undefined &&
          workspace.name !== undefined
          ? [toAttrs(group, workspace.name, workspace)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const computeMode = news.computeMode ?? "Hybrid";
      const name = news.name ?? output.workspaceName;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(name) !== lower(output.workspaceName) ||
        (news.location !== undefined &&
          lower(news.location) !== lower(output.location)) ||
        lower(computeMode) !== lower(output.computeMode) ||
        (computeMode === "Hybrid" &&
          output.managedResourceGroupId !== undefined &&
          lower(output.managedResourceGroupId.split("/").pop()) !==
            lower(managedGroupName(news, name)))
      ) {
        return { action: "replace" } as const;
      }
      if (olds !== undefined) {
        const immutable = [
          "customVirtualNetworkId",
          "vnetAddressPrefix",
          "storageAccountName",
          "storageAccountSkuName",
          "requireInfrastructureEncryption",
          "defaultCatalog",
        ] as const;
        for (const key of immutable) {
          if (canonical(news[key]) !== canonical(olds[key])) {
            return { action: "replace" } as const;
          }
        }
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.workspaceName ?? olds?.name ?? (yield* createName(id));
      const observed = yield* getWorkspace(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Databricks");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.workspaceName ?? (yield* createName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const computeMode = news.computeMode ?? "Hybrid";
      const hybrid = computeMode === "Hybrid";
      const sku = news.sku ?? "premium";
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        workspaceName: name,
      };
      const label = `Databricks workspace ${name}`;
      const get = getWorkspace(subscriptionId, resourceGroup, name);
      const wait = waitForProvisioned(
        label,
        get,
        (workspace) => workspace.properties.provisioningState,
        { interval: "10 seconds", times: 90 },
      );
      const params = desiredParameters(news);

      // Full desired body for a PUT. On update, observed parameters are
      // carried over so unspecified ones keep their current values.
      const putBody = (current: Observed | undefined) => {
        const observedParams = { ...current?.properties.parameters };
        delete observedParams.resourceTags;
        const parameters = Object.fromEntries(
          Object.entries({ ...observedParams, ...params }).filter(
            ([, v]) => v !== undefined,
          ),
        ) as databricks.WorkspaceCustomParameters;
        return {
          ...where,
          location: current?.location ?? location,
          tags,
          sku: { name: sku },
          properties: {
            computeMode,
            managedResourceGroupId: hybrid
              ? (current?.properties.managedResourceGroupId ??
                `/subscriptions/${subscriptionId}/resourceGroups/${managedGroupName(news, name)}`)
              : undefined,
            parameters: hybrid ? parameters : undefined,
            publicNetworkAccess: news.publicNetworkAccess,
            requiredNsgRules: news.requiredNsgRules,
            defaultCatalog:
              current === undefined ? news.defaultCatalog : undefined,
            accessConnector: news.accessConnector,
            defaultStorageFirewall: news.defaultStorageFirewall,
            encryption: news.encryption,
            enhancedSecurityCompliance: news.enhancedSecurityCompliance,
          },
        };
      };

      // Observe.
      let observed = yield* get;

      // Ensure. Creation is a long-running operation (3-6 minutes).
      if (observed === undefined) {
        yield* databricks
          .WorkspacesCreateOrUpdate(putBody(undefined))
          .pipe(Effect.retry(whileApplianceBusy));
      }
      observed = yield* wait;

      // Sync mutable properties against observed state with one PUT; a
      // tag-only change is a PATCH.
      const p = observed.properties;
      const observedParam = (key: keyof databricks.WorkspaceCustomParameters) =>
        (p.parameters?.[key] as { value?: unknown } | undefined)?.value;
      const paramDrifted = (
        key: keyof databricks.WorkspaceCustomParameters,
        fallback?: unknown,
      ) => {
        const desired = (params[key] as { value?: unknown } | undefined)?.value;
        return (
          desired !== undefined && desired !== (observedParam(key) ?? fallback)
        );
      };
      const propsDrifted =
        lower(observed.sku?.name) !== lower(sku) ||
        (hybrid &&
          (paramDrifted("enableNoPublicIp", false) ||
            paramDrifted("prepareEncryption", false) ||
            paramDrifted("customPublicSubnetName") ||
            paramDrifted("customPrivateSubnetName"))) ||
        (news.publicNetworkAccess !== undefined &&
          news.publicNetworkAccess !== p.publicNetworkAccess) ||
        (news.requiredNsgRules !== undefined &&
          news.requiredNsgRules !== p.requiredNsgRules) ||
        (news.defaultStorageFirewall !== undefined &&
          news.defaultStorageFirewall !== p.defaultStorageFirewall) ||
        (news.accessConnector !== undefined &&
          (lower(news.accessConnector.id) !== lower(p.accessConnector?.id) ||
            news.accessConnector.identityType !==
              p.accessConnector?.identityType ||
            lower(news.accessConnector.userAssignedIdentityId) !==
              lower(p.accessConnector?.userAssignedIdentityId))) ||
        differs(news.encryption, p.encryption) ||
        differs(news.enhancedSecurityCompliance, p.enhancedSecurityCompliance);
      if (propsDrifted) {
        yield* databricks
          .WorkspacesCreateOrUpdate(putBody(observed))
          .pipe(Effect.retry(whileApplianceBusy));
        observed = yield* wait;
      } else if (tagsDiffer(observed.tags, tags)) {
        yield* databricks
          .UpdateWorkspace({ ...where, tags })
          .pipe(Effect.retry(whileApplianceBusy));
        observed = yield* wait;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        databricks
          .DeleteWorkspace({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            workspaceName: output.workspaceName,
            forceDeletion: olds?.forceDeletion,
          })
          .pipe(Effect.retry(whileApplianceBusy)),
      );
      // Deletion tears down the managed resource group: up to ~15 minutes.
      yield* waitUntilGone(
        `Databricks workspace ${output.workspaceName}`,
        getWorkspace(
          subscriptionId,
          output.resourceGroup,
          output.workspaceName,
        ),
        { interval: "10 seconds", times: 120 },
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.Databricks.AccessConnector",
      ],
    },
  });
