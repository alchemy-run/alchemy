import * as discovery from "@distilled.cloud/azure/discovery";
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
  createDiscoveryName,
  DISCOVERY_NAMESPACE,
  idSetKey,
  lower,
  sameLocation,
} from "./common.ts";

/** Customer-managed key used to encrypt a workspace's data at rest. */
export interface WorkspaceKeyVaultKey {
  /** Key Vault URI. Changing it replaces the workspace. */
  keyVaultUri: string;
  /** Key name in the vault. */
  keyName: string;
  /** Key version; omit to track the latest version. */
  keyVersion?: string;
}

export interface WorkspaceProps {
  /** Resource group the workspace is created in. Changing it replaces the workspace. */
  resourceGroup: string;
  /**
   * Workspace name: 3-24 letters, digits, and hyphens. If omitted, a unique
   * name is generated from the app, stage, and logical ID. Changing it
   * replaces the workspace.
   */
  name?: string;
  /**
   * Azure location. Changing it replaces the workspace.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM ID of the user-assigned identity the workspace uses to reach its
   * resources. Changing it replaces the workspace.
   */
  workspaceIdentity: string;
  /** ARM IDs of the Discovery supercomputers linked to the workspace. */
  supercomputerIds?: string[];
  /**
   * Encrypt data at rest with a customer-managed key. Changing it replaces
   * the workspace.
   * @default "Disabled"
   */
  customerManagedKeys?: "Enabled" | "Disabled";
  /** Customer-managed key, required when `customerManagedKeys` is `Enabled`. */
  keyVaultProperties?: WorkspaceKeyVaultKey;
  /**
   * Log Analytics cluster for debug logs (required with customer-managed
   * keys). Changing it replaces the workspace.
   */
  logAnalyticsClusterId?: string;
  /**
   * Whether public network access is allowed.
   * @default Azure's default (`Disabled`)
   */
  publicNetworkAccess?: "Enabled" | "Disabled";
  /** Subnet for agent resources. Changing it replaces the workspace. */
  agentSubnetId?: string;
  /** Subnet for private endpoint connections. Changing it replaces the workspace. */
  privateEndpointSubnetId?: string;
  /** Subnet for workspace (function) resources. Changing it replaces the workspace. */
  workspaceSubnetId?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Workspace extends Resource<
  "Azure.Discovery.Workspace",
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
    /** Workspace data-plane API endpoint. */
    workspaceApiUri: string | undefined;
    /** Workspace web UI endpoint. */
    workspaceUiUri: string | undefined;
    /** Resource group Azure manages for the workspace's backing resources. */
    managedResourceGroup: string | undefined;
    /** ARM IDs of the linked supercomputers. */
    supercomputerIds: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A Microsoft Discovery workspace (`Microsoft.Discovery/workspaces`) — the
 * top-level R&D environment that hosts Discovery agents, projects, and chat
 * model deployments, and links supercomputers for compute.
 *
 * Provisioning creates an Azure-managed resource group with the
 * workspace's backing services and takes 20-40 minutes. Microsoft Discovery
 * is a gated preview: on subscriptions without the preview, ARM rejects the
 * resource type with `InvalidResourceType`.
 *
 * @see https://learn.microsoft.com/azure/microsoft-discovery/
 *
 * ### Creating a Workspace
 * **Example:** Workspace with a user-assigned identity
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("science");
 * const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity("ws", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const workspace = yield* Azure.Discovery.Workspace("lab", {
 *   resourceGroup: group.resourceGroupName,
 *   workspaceIdentity: identity.identityId,
 * });
 * ```
 *
 * ### Linking Compute
 * **Example:** Workspace linked to a supercomputer
 * ```typescript
 * const workspace = yield* Azure.Discovery.Workspace("lab", {
 *   resourceGroup: group.resourceGroupName,
 *   workspaceIdentity: identity.identityId,
 *   supercomputerIds: [supercomputer.supercomputerId],
 *   publicNetworkAccess: "Enabled",
 * });
 * ```
 *
 * @resource
 */
export const Workspace = Resource<Workspace>("Azure.Discovery.Workspace");

/**
 * Without the Discovery preview ARM rejects the type itself
 * (`InvalidResourceType`): no workspace can exist there.
 */
export const getWorkspace = (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
) =>
  orUndefinedIfNotFound(
    discovery.GetWorkspace({
      subscriptionId,
      resourceGroupName,
      workspaceName,
    }),
  ).pipe(
    Effect.catchTag("InvalidResourceType", () => Effect.succeed(undefined)),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: Pick<
    discovery.GetWorkspaceResponse,
    "id" | "location" | "properties" | "tags"
  >,
): Workspace["Attributes"] => ({
  workspaceName: name,
  workspaceId: observed.id ?? "",
  resourceGroup,
  location: observed.location,
  workspaceApiUri: observed.properties?.workspaceApiUri,
  workspaceUiUri: observed.properties?.workspaceUiUri,
  managedResourceGroup: observed.properties?.managedResourceGroup,
  supercomputerIds: [...(observed.properties?.supercomputerIds ?? [])],
  tags: userTags(observed.tags),
});

export const WorkspaceProvider = () =>
  Provider.succeed(Workspace, {
    stables: [
      "workspaceName",
      "workspaceId",
      "resourceGroup",
      "location",
      "workspaceApiUri",
      "workspaceUiUri",
      "managedResourceGroup",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* discovery
        .ListWorkspaceBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListWorkspaceBySubscription", page),
          ),
          Effect.catchTag("InvalidResourceType", () =>
            Effect.succeed(undefined),
          ),
        );
      return (page?.value ?? []).flatMap((observed) => {
        const group = resourceGroupOf(observed.id);
        return hasAnyAlchemyTag(observed.tags) &&
          group !== undefined &&
          observed.name !== undefined
          ? [toAttrs(group, observed.name, observed)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.workspaceName)) ||
        (news.location !== undefined &&
          !sameLocation(news.location, output.location)) ||
        lower(news.workspaceIdentity) !== lower(olds?.workspaceIdentity) ||
        (news.customerManagedKeys ?? "Disabled") !==
          (olds?.customerManagedKeys ?? "Disabled") ||
        lower(news.keyVaultProperties?.keyVaultUri) !==
          lower(olds?.keyVaultProperties?.keyVaultUri) ||
        lower(news.logAnalyticsClusterId) !==
          lower(olds?.logAnalyticsClusterId) ||
        lower(news.agentSubnetId) !== lower(olds?.agentSubnetId) ||
        lower(news.privateEndpointSubnetId) !==
          lower(olds?.privateEndpointSubnetId) ||
        lower(news.workspaceSubnetId) !== lower(olds?.workspaceSubnetId)
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
        output?.workspaceName ?? olds?.name ?? (yield* createDiscoveryName(id));
      const observed = yield* getWorkspace(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, DISCOVERY_NAMESPACE);
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.workspaceName ?? (yield* createDiscoveryName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        workspaceName: name,
      };
      const get = getWorkspace(subscriptionId, resourceGroup, name);
      // 20-40 minutes: the workspace provisions a managed resource group.
      const ready = waitForProvisioned(
        `discovery workspace ${name}`,
        get,
        (workspace) => workspace.properties?.provisioningState,
        { interval: "40 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* discovery.WorkspacesCreateOrUpdate({
          ...where,
          location,
          tags,
          properties: {
            workspaceIdentity: { id: news.workspaceIdentity },
            supercomputerIds: news.supercomputerIds,
            customerManagedKeys: news.customerManagedKeys,
            keyVaultProperties: news.keyVaultProperties,
            logAnalyticsClusterId: news.logAnalyticsClusterId,
            publicNetworkAccess: news.publicNetworkAccess,
            agentSubnetId: news.agentSubnetId,
            privateEndpointSubnetId: news.privateEndpointSubnetId,
            workspaceSubnetId: news.workspaceSubnetId,
          },
        });
      }
      observed = yield* ready;

      // Sync the mutable aspects against observed state.
      const props = observed.properties;
      const supercomputersChanged =
        news.supercomputerIds !== undefined &&
        idSetKey(news.supercomputerIds) !== idSetKey(props?.supercomputerIds);
      const accessChanged =
        news.publicNetworkAccess !== undefined &&
        props?.publicNetworkAccess !== news.publicNetworkAccess;
      const key = news.keyVaultProperties;
      const keyChanged =
        key !== undefined &&
        (props?.keyVaultProperties?.keyName !== key.keyName ||
          (key.keyVersion !== undefined &&
            props?.keyVaultProperties?.keyVersion !== key.keyVersion));
      const tagsChanged = tagsDiffer(observed.tags, tags);
      const propsChanged = supercomputersChanged || accessChanged || keyChanged;
      if (propsChanged || tagsChanged) {
        yield* discovery.UpdateWorkspace({
          ...where,
          tags: tagsChanged ? tags : undefined,
          properties: propsChanged
            ? {
                supercomputerIds: supercomputersChanged
                  ? news.supercomputerIds
                  : undefined,
                publicNetworkAccess: accessChanged
                  ? news.publicNetworkAccess
                  : undefined,
                keyVaultProperties:
                  keyChanged && key !== undefined
                    ? { keyName: key.keyName, keyVersion: key.keyVersion }
                    : undefined,
              }
            : undefined,
        });
        observed = yield* ready;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        discovery.DeleteWorkspace({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          workspaceName: output.workspaceName,
        }),
      ).pipe(Effect.catchTag("InvalidResourceType", () => Effect.void));
      yield* waitUntilGone(
        `discovery workspace ${output.workspaceName}`,
        getWorkspace(
          subscriptionId,
          output.resourceGroup,
          output.workspaceName,
        ),
        { interval: "30 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
