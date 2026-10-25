import * as desktopvirtualization from "@distilled.cloud/azure/desktopvirtualization";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  collectAll,
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { createAvdName, deltaOf, sameIdSet } from "./Common.ts";

export interface WorkspaceProps {
  /**
   * Resource group of the workspace. Changing it replaces the workspace.
   * @default the stack's resource group (`<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * Workspace name, 3-64 letters, digits, `@`, `.`, `-`, `_`, or spaces. If
   * omitted, a unique name is generated from the app, stage, and logical ID.
   * Changing it replaces the workspace.
   * @default a unique name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Azure Virtual Desktop metadata location of the workspace. Changing it
   * replaces the workspace.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM IDs of the application groups published in the workspace. An
   * application group belongs to at most one workspace.
   * @default []
   */
  applicationGroupIds?: string[];
  /**
   * Display name shown to users.
   * @default unset
   */
  friendlyName?: string;
  /**
   * Description of the workspace.
   * @default unset
   */
  description?: string;
  /**
   * Whether the workspace feed is reachable from the public network.
   * @default Azure's default (`Enabled`)
   */
  publicNetworkAccess?: "Enabled" | "Disabled";
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   * @default no user tags
   */
  tags?: Record<string, string>;
}

export interface Workspace extends Resource<
  "Azure.DesktopVirtualization.Workspace",
  WorkspaceProps,
  {
    /** Name of the workspace. */
    workspaceName: string;
    /** ARM resource ID of the workspace. */
    workspaceId: string;
    /** Resource group of the workspace. */
    resourceGroup: string;
    /** Metadata location of the workspace. */
    location: string;
    /** Internal object ID of the workspace. */
    objectId: string | undefined;
    /** ARM IDs of the application groups published in the workspace. */
    applicationGroupIds: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Virtual Desktop workspace
 * (`Microsoft.DesktopVirtualization/workspaces`) — the feed users subscribe
 * to. It publishes a set of application groups; users see the desktops and
 * RemoteApps of every group they are assigned to.
 *
 * :::caution
 * Changing `name`, `location`, or `resourceGroup` replaces the workspace.
 * :::
 *
 * @see https://learn.microsoft.com/azure/virtual-desktop/terminology#workspaces
 *
 * ### Creating a Workspace
 * **Example:** Publish a desktop application group
 * ```typescript
 * const pool = yield* Azure.DesktopVirtualization.HostPool("pool", {
 *   hostPoolType: "Pooled",
 *   loadBalancerType: "BreadthFirst",
 * });
 * const desktops = yield* Azure.DesktopVirtualization.ApplicationGroup("desktops", {
 *   hostPoolId: pool.hostPoolId,
 *   applicationGroupType: "Desktop",
 * });
 * const workspace = yield* Azure.DesktopVirtualization.Workspace("feed", {
 *   friendlyName: "Contoso",
 *   applicationGroupIds: [desktops.applicationGroupId],
 * });
 * ```
 *
 * **Example:** Private-only workspace
 * ```typescript
 * const workspace = yield* Azure.DesktopVirtualization.Workspace("feed", {
 *   publicNetworkAccess: "Disabled",
 * });
 * ```
 *
 * @resource
 */
export const Workspace = GroupedResource<Workspace>("Azure.DesktopVirtualization.Workspace");

type ObservedWorkspace = desktopvirtualization.GetWorkspaceResponse;

const getWorkspace = (subscriptionId: string, resourceGroupName: string, workspaceName: string) =>
  orUndefinedIfNotFound(
    desktopvirtualization.GetWorkspace({
      subscriptionId,
      resourceGroupName,
      workspaceName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  workspace: ObservedWorkspace,
): Workspace["Attributes"] => ({
  workspaceName: name,
  workspaceId: workspace.id ?? "",
  resourceGroup,
  location: workspace.location,
  objectId: workspace.properties?.objectId,
  applicationGroupIds: workspace.properties?.applicationGroupReferences ?? [],
  tags: userTags(workspace.tags),
});

export const WorkspaceProvider = () =>
  Provider.succeed(Workspace, {
    stables: ["workspaceName", "workspaceId", "resourceGroup", "location", "objectId"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* collectAll(desktopvirtualization.ListWorkspaceBySubscription, {
        subscriptionId,
      });
      return (page.value ?? []).flatMap((workspace) => {
        const rg = resourceGroupOf(workspace.id);
        return hasAnyAlchemyTag(workspace.tags) && rg !== undefined && workspace.name !== undefined
          ? [toAttrs(rg, workspace.name, workspace)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !== output.resourceGroup.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.workspaceName.toLowerCase()) ||
        (news.location !== undefined &&
          news.location.toLowerCase() !== output.location.toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name = output?.workspaceName ?? olds?.name ?? (yield* createAvdName(id, 64));
      const observed = yield* getWorkspace(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.DesktopVirtualization");
      const resourceGroup = news.resourceGroup;
      const name = news.name ?? output?.workspaceName ?? (yield* createAvdName(id, 64));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const applicationGroupReferences = news.applicationGroupIds ?? [];
      const desired = {
        friendlyName: news.friendlyName,
        description: news.description,
        publicNetworkAccess: news.publicNetworkAccess,
      };
      const request = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        workspaceName: name,
      };

      // Observe.
      let observed: ObservedWorkspace | undefined = yield* getWorkspace(
        subscriptionId,
        resourceGroup,
        name,
      );

      if (observed === undefined) {
        // Ensure: the PUT is synchronous.
        observed = yield* desktopvirtualization.WorkspacesCreateOrUpdate({
          ...request,
          location,
          tags,
          properties: { ...desired, applicationGroupReferences },
        });
      } else {
        // Sync: PATCH only the observed deltas. References compare as a set.
        const delta = deltaOf(desired, observed.properties);
        const referencesChanged = !sameIdSet(
          observed.properties?.applicationGroupReferences,
          applicationGroupReferences,
        );
        const tagsChanged = tagsDiffer(observed.tags, tags);
        if (delta !== undefined || referencesChanged || tagsChanged) {
          observed = yield* desktopvirtualization.UpdateWorkspace({
            ...request,
            tags: tagsChanged ? tags : undefined,
            properties: {
              ...delta,
              ...(referencesChanged ? { applicationGroupReferences } : {}),
            },
          });
        }
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        desktopvirtualization.DeleteWorkspace({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          workspaceName: output.workspaceName,
        }),
      );
      yield* waitUntilGone(
        `workspace ${output.workspaceName}`,
        getWorkspace(subscriptionId, output.resourceGroup, output.workspaceName),
      );
    }),

    nuke: {
      dependsOn: ["Azure.DesktopVirtualization.ApplicationGroup", "Azure.Resources.ResourceGroup"],
    },
  });
