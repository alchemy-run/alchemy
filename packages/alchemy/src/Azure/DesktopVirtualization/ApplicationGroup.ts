import * as desktopvirtualization from "@distilled.cloud/azure/desktopvirtualization";
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
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { createAvdName, deltaOf } from "./Common.ts";

export type ApplicationGroupType = "Desktop" | "RemoteApp";

export interface ApplicationGroupProps {
  /**
   * Resource group of the application group. Changing it replaces the
   * application group.
   */
  resourceGroup: string;
  /**
   * Application group name, 3-64 letters, digits, `@`, `.`, `-`, `_`, or
   * spaces. If omitted, a unique name is generated from the app, stage, and
   * logical ID. Changing it replaces the application group.
   */
  name?: string;
  /**
   * Azure Virtual Desktop metadata location of the application group.
   * Changing it replaces the application group.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM ID of the host pool that serves the group's desktop or apps.
   * Changing it replaces the application group.
   */
  hostPoolId: string;
  /**
   * `Desktop` publishes the full desktop; `RemoteApp` publishes individual
   * applications. Changing it replaces the application group.
   */
  applicationGroupType: ApplicationGroupType;
  /** Display name shown to users. */
  friendlyName?: string;
  /** Description of the application group. */
  description?: string;
  /** Whether the group appears in users' feeds. */
  showInFeed?: boolean;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface ApplicationGroup extends Resource<
  "Azure.DesktopVirtualization.ApplicationGroup",
  ApplicationGroupProps,
  {
    /** Name of the application group. */
    applicationGroupName: string;
    /** ARM resource ID of the application group. */
    applicationGroupId: string;
    /** Resource group of the application group. */
    resourceGroup: string;
    /** Metadata location of the application group. */
    location: string;
    /** ARM ID of the host pool. */
    hostPoolId: string;
    /** Application group type. */
    applicationGroupType: string;
    /** Internal object ID of the application group. */
    objectId: string | undefined;
    /** ARM ID of the workspace that references the group, if any. */
    workspaceId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Virtual Desktop application group — a set of resources (a full
 * desktop, or individual RemoteApp applications) published from a host
 * pool. Grant users access with a `Desktop Virtualization User` role
 * assignment scoped to the group, and add the group to a workspace so it
 * appears in their feed.
 *
 * @see https://learn.microsoft.com/azure/virtual-desktop/terminology#application-groups
 *
 * ### Creating an Application Group
 * **Example:** Desktop application group
 * ```typescript
 * const desktops = yield* Azure.DesktopVirtualization.ApplicationGroup("desktops", {
 *   resourceGroup: group.resourceGroupName,
 *   hostPoolId: pool.hostPoolId,
 *   applicationGroupType: "Desktop",
 *   friendlyName: "Office desktop",
 * });
 * ```
 *
 * **Example:** RemoteApp application group
 * ```typescript
 * const apps = yield* Azure.DesktopVirtualization.ApplicationGroup("apps", {
 *   resourceGroup: group.resourceGroupName,
 *   hostPoolId: pool.hostPoolId,
 *   applicationGroupType: "RemoteApp",
 * });
 * ```
 *
 * @resource
 */
export const ApplicationGroup = Resource<ApplicationGroup>(
  "Azure.DesktopVirtualization.ApplicationGroup",
);

type ObservedApplicationGroup =
  desktopvirtualization.GetApplicationGroupResponse;

export const getApplicationGroup = (
  subscriptionId: string,
  resourceGroupName: string,
  applicationGroupName: string,
) =>
  orUndefinedIfNotFound(
    desktopvirtualization.GetApplicationGroup({
      subscriptionId,
      resourceGroupName,
      applicationGroupName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  group: ObservedApplicationGroup,
): ApplicationGroup["Attributes"] => ({
  applicationGroupName: name,
  applicationGroupId: group.id ?? "",
  resourceGroup,
  location: group.location,
  hostPoolId: group.properties?.hostPoolArmPath ?? "",
  applicationGroupType: group.properties?.applicationGroupType ?? "",
  objectId: group.properties?.objectId,
  workspaceId: group.properties?.workspaceArmPath || undefined,
  tags: userTags(group.tags),
});

export const ApplicationGroupProvider = () =>
  Provider.succeed(ApplicationGroup, {
    stables: [
      "applicationGroupName",
      "applicationGroupId",
      "resourceGroup",
      "location",
      "hostPoolId",
      "applicationGroupType",
      "objectId",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* desktopvirtualization
        .ListApplicationGroupBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListApplicationGroupBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((group) => {
        const rg = resourceGroupOf(group.id);
        return hasAnyAlchemyTag(group.tags) &&
          rg !== undefined &&
          group.name !== undefined
          ? [toAttrs(rg, group.name, group)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !==
            output.applicationGroupName.toLowerCase()) ||
        (news.location !== undefined &&
          news.location.toLowerCase() !== output.location.toLowerCase()) ||
        news.hostPoolId.toLowerCase() !== output.hostPoolId.toLowerCase() ||
        news.applicationGroupType.toLowerCase() !==
          output.applicationGroupType.toLowerCase()
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
        output?.applicationGroupName ??
        olds?.name ??
        (yield* createAvdName(id, 64));
      const observed = yield* getApplicationGroup(
        subscriptionId,
        resourceGroup,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(
        subscriptionId,
        "Microsoft.DesktopVirtualization",
      );
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.applicationGroupName ??
        (yield* createAvdName(id, 64));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const desired = {
        friendlyName: news.friendlyName,
        description: news.description,
        showInFeed: news.showInFeed,
      };
      const request = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        applicationGroupName: name,
      };

      // Observe.
      let observed: ObservedApplicationGroup | undefined =
        yield* getApplicationGroup(subscriptionId, resourceGroup, name);

      if (observed === undefined) {
        // Ensure: the PUT is synchronous.
        observed = yield* desktopvirtualization.ApplicationGroupsCreateOrUpdate(
          {
            ...request,
            location,
            tags,
            properties: {
              ...desired,
              hostPoolArmPath: news.hostPoolId,
              applicationGroupType: news.applicationGroupType,
            },
          },
        );
      } else {
        // Sync: PATCH only the observed deltas.
        const delta = deltaOf(desired, observed.properties);
        const tagsChanged = tagsDiffer(observed.tags, tags);
        if (delta !== undefined || tagsChanged) {
          observed = yield* desktopvirtualization.UpdateApplicationGroup({
            ...request,
            tags: tagsChanged ? tags : undefined,
            properties: delta,
          });
        }
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        desktopvirtualization.DeleteApplicationGroup({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          applicationGroupName: output.applicationGroupName,
        }),
      );
      yield* waitUntilGone(
        `application group ${output.applicationGroupName}`,
        getApplicationGroup(
          subscriptionId,
          output.resourceGroup,
          output.applicationGroupName,
        ),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.DesktopVirtualization.HostPool",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
