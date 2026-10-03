import * as storagediscovery from "@distilled.cloud/azure/storagediscovery";
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

/**
 * A collection of storage resources a Storage Discovery workspace reports on.
 */
export interface WorkspaceScope {
  /** Display name of the scope (at least 4 characters), shown in reports. */
  displayName: string;
  /**
   * Resource types collected by the scope.
   * @default ["Microsoft.Storage/storageAccounts"]
   */
  resourceTypes?: "Microsoft.Storage/storageAccounts"[];
  /**
   * Only include storage accounts that carry these tag keys (any value).
   */
  tagKeysOnly?: string[];
  /**
   * Only include storage accounts that carry these exact tag key/value pairs.
   */
  tags?: Record<string, string>;
}

export interface WorkspaceProps {
  /**
   * Resource group the workspace is created in. Changing it replaces the
   * workspace.
   */
  resourceGroup: string;
  /**
   * Name of the workspace. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the workspace.
   */
  name?: string;
  /**
   * Azure location of the workspace. Storage Discovery is available in a
   * limited set of regions (e.g. `eastus2`, `westus2`, `southcentralus`,
   * `canadacentral`, `westeurope`, `northeurope`, `francecentral`,
   * `australiaeast`, `centralindia`, `japaneast`, `brazilsouth`); other
   * regions fail with `LocationNotAvailable`. Changing it replaces the
   * workspace.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Pricing tier. `Free` keeps 15 days of insights with a reduced metric
   * set; `Standard` adds the full metric set and 18 months of history.
   * @default "Free"
   */
  sku?: "Free" | "Standard";
  /** Description of the workspace. */
  description?: string;
  /**
   * ARM IDs of the subscriptions and/or resource groups whose storage
   * estate the workspace covers (e.g.
   * `/subscriptions/<id>/resourceGroups/<name>`). The deploying principal
   * needs read access to every root.
   */
  workspaceRoots: string[];
  /**
   * Scopes that group the storage resources found under the workspace
   * roots. At least one is required.
   */
  scopes: WorkspaceScope[];
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Workspace extends Resource<
  "Azure.StorageDiscovery.Workspace",
  WorkspaceProps,
  {
    /** Name of the workspace. */
    workspaceName: string;
    /** Resource group that holds the workspace. */
    resourceGroup: string;
    /** ARM resource ID of the workspace. */
    workspaceId: string;
    /** Location of the workspace. */
    location: string;
    /** Pricing tier of the workspace. */
    sku: string;
    /** Description of the workspace. */
    description: string | undefined;
    /** ARM IDs of the workspace roots. */
    workspaceRoots: string[];
    /** Provisioning state reported by Azure. */
    provisioningState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Storage Discovery workspace — aggregated insights (capacity,
 * activity, security and configuration) across every storage account under
 * a set of subscriptions or resource groups, grouped into scopes filtered by
 * resource tags.
 *
 * @see https://learn.microsoft.com/azure/storage-discovery/overview
 *
 * ### Creating a Workspace
 * **Example:** Free workspace over one resource group
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("data");
 * const workspace = yield* Azure.StorageDiscovery.Workspace("insights", {
 *   resourceGroup: group.resourceGroupName,
 *   location: "eastus2",
 *   workspaceRoots: [group.resourceGroupId],
 *   scopes: [{ displayName: "All storage" }],
 * });
 * ```
 *
 * ### Filtering by Tags
 * **Example:** Separate scopes for production and tagged accounts
 * ```typescript
 * const workspace = yield* Azure.StorageDiscovery.Workspace("insights", {
 *   resourceGroup: group.resourceGroupName,
 *   sku: "Standard",
 *   description: "Storage estate overview",
 *   workspaceRoots: [`/subscriptions/${subscriptionId}`],
 *   scopes: [
 *     { displayName: "Production", tags: { env: "prod" } },
 *     { displayName: "Owned", tagKeysOnly: ["owner"] },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const Workspace = Resource<Workspace>(
  "Azure.StorageDiscovery.Workspace",
);

type ObservedWorkspace = storagediscovery.GetStorageDiscoveryWorkspaceResponse;
type Scope = storagediscovery.StorageDiscoveryScope;

const getWorkspace = (
  subscriptionId: string,
  resourceGroupName: string,
  storageDiscoveryWorkspaceName: string,
) =>
  orUndefinedIfNotFound(
    storagediscovery.GetStorageDiscoveryWorkspace({
      subscriptionId,
      resourceGroupName,
      storageDiscoveryWorkspaceName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  workspace: ObservedWorkspace,
): Workspace["Attributes"] => ({
  workspaceName: name,
  resourceGroup,
  workspaceId: workspace.id ?? "",
  location: workspace.location,
  sku: workspace.properties?.sku ?? "Free",
  description: workspace.properties?.description,
  workspaceRoots: [...(workspace.properties?.workspaceRoots ?? [])],
  provisioningState: workspace.properties?.provisioningState,
  tags: userTags(workspace.tags),
});

const toScopes = (scopes: WorkspaceScope[]): Scope[] =>
  scopes.map((scope) => ({
    displayName: scope.displayName,
    resourceTypes: scope.resourceTypes ?? ["Microsoft.Storage/storageAccounts"],
    ...(scope.tagKeysOnly !== undefined
      ? { tagKeysOnly: scope.tagKeysOnly }
      : {}),
    ...(scope.tags !== undefined ? { tags: scope.tags } : {}),
  }));

// Canonical form for comparing observed and desired scopes: Azure echoes
// empty filters as `[]` / `{}` and may reorder map keys.
const canonicalScopes = (scopes: readonly Scope[] | undefined) =>
  JSON.stringify(
    (scopes ?? []).map((scope) => ({
      displayName: scope.displayName,
      resourceTypes: [...(scope.resourceTypes ?? [])]
        .map((t) => t.toLowerCase())
        .sort(),
      tagKeysOnly: [...(scope.tagKeysOnly ?? [])].sort(),
      tags: Object.entries(scope.tags ?? {}).sort(([a], [b]) =>
        a.localeCompare(b),
      ),
    })),
  );

const canonicalRoots = (roots: readonly string[] | undefined) =>
  JSON.stringify([...(roots ?? [])].map((r) => r.toLowerCase()).sort());

export const WorkspaceProvider = () =>
  Provider.succeed(Workspace, {
    stables: ["workspaceName", "resourceGroup", "workspaceId", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* storagediscovery
        .ListStorageDiscoveryWorkspaceBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage(
              "ListStorageDiscoveryWorkspaceBySubscription",
              page,
            ),
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

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.workspaceName.toLowerCase()) ||
        (news.location !== undefined &&
          news.location.replace(/\s/g, "").toLowerCase() !==
            output.location.replace(/\s/g, "").toLowerCase())
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
        output?.workspaceName ??
        olds?.name ??
        (yield* createPhysicalName({ id, maxLength: 64 }));
      const observed = yield* getWorkspace(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.StorageDiscovery");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.workspaceName ??
        (yield* createPhysicalName({ id, maxLength: 64 }));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const sku = news.sku ?? "Free";
      const scopes = toScopes(news.scopes);
      const request = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        storageDiscoveryWorkspaceName: name,
      };

      // Observe.
      let observed = yield* getWorkspace(subscriptionId, resourceGroup, name);

      // Ensure: PUT the full desired body when missing.
      if (observed === undefined) {
        observed =
          yield* storagediscovery.StorageDiscoveryWorkspacesCreateOrUpdate({
            ...request,
            location,
            tags,
            properties: {
              sku,
              description: news.description,
              workspaceRoots: news.workspaceRoots,
              scopes,
            },
          });
      } else {
        // Sync: PATCH only the aspects that differ from observed state.
        const props = observed.properties;
        const delta: storagediscovery.StorageDiscoveryWorkspacePropertiesUpdate =
          {};
        if ((props?.sku ?? "Free").toLowerCase() !== sku.toLowerCase()) {
          delta.sku = sku;
        }
        if (
          news.description !== undefined &&
          props?.description !== news.description
        ) {
          delta.description = news.description;
        }
        if (
          canonicalRoots(props?.workspaceRoots) !==
          canonicalRoots(news.workspaceRoots)
        ) {
          delta.workspaceRoots = news.workspaceRoots;
        }
        if (canonicalScopes(props?.scopes) !== canonicalScopes(scopes)) {
          delta.scopes = scopes;
        }
        const syncTags = tagsDiffer(observed.tags, tags);
        if (Object.keys(delta).length > 0 || syncTags) {
          observed = yield* storagediscovery.UpdateStorageDiscoveryWorkspace({
            ...request,
            ...(syncTags ? { tags } : {}),
            ...(Object.keys(delta).length > 0 ? { properties: delta } : {}),
          });
        }
      }

      const ready = yield* waitForProvisioned(
        `storage discovery workspace ${name}`,
        getWorkspace(subscriptionId, resourceGroup, name),
        (workspace) => workspace.properties?.provisioningState,
      );
      return toAttrs(resourceGroup, name, ready ?? observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        storagediscovery.DeleteStorageDiscoveryWorkspace({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          storageDiscoveryWorkspaceName: output.workspaceName,
        }),
      );
      yield* waitUntilGone(
        `storage discovery workspace ${output.workspaceName}`,
        getWorkspace(
          subscriptionId,
          output.resourceGroup,
          output.workspaceName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
