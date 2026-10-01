import * as resources from "@distilled.cloud/azure/resources";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  requireSinglePage,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

export interface ResourceGroupProps {
  /**
   * Name of the resource group. Must be unique within the subscription;
   * 1-90 characters of letters, digits, `-`, `_`, `.`, and `()`, not ending
   * in `.`. If omitted, a unique name is generated from the app, stage, and
   * logical ID. Changing it replaces the resource group.
   */
  name?: string;
  /**
   * Azure location that stores the resource group's metadata, e.g.
   * `eastus` or `westeurope`. Resources inside the group may live in other
   * locations. Changing it replaces the resource group.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface ResourceGroup extends Resource<
  "Azure.Resources.ResourceGroup",
  ResourceGroupProps,
  {
    /** Name of the resource group. */
    resourceGroupName: string;
    /** ARM resource ID, `/subscriptions/{id}/resourceGroups/{name}`. */
    resourceGroupId: string;
    /** Location that stores the resource group's metadata. */
    location: string;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure resource group — the container every other Azure resource is
 * deployed into. Deleting a resource group deletes everything in it.
 *
 * @see https://learn.microsoft.com/azure/azure-resource-manager/management/manage-resource-groups-portal
 *
 * ### Creating a Resource Group
 * **Example:** Resource group in the default location
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("app");
 * ```
 *
 * **Example:** Resource group with a fixed name, location, and tags
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("app", {
 *   name: "my-app-prod",
 *   location: "westeurope",
 *   tags: { team: "platform" },
 * });
 * ```
 *
 * ### Deploying into a Resource Group
 * **Example:** Storage account inside the group
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("app");
 * const account = yield* Azure.Storage.StorageAccount("files", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * @resource
 */
export const ResourceGroup = Resource<ResourceGroup>(
  "Azure.Resources.ResourceGroup",
);

type ObservedResourceGroup = resources.GetResourceGroupResponse;

const createGroupName = (id: string, name: string | undefined) =>
  name !== undefined
    ? Effect.succeed(name)
    : createPhysicalName({ id, maxLength: 90 });

const getGroup = (subscriptionId: string, resourceGroupName: string) =>
  orUndefinedIfNotFound(
    resources.GetResourceGroup({ subscriptionId, resourceGroupName }),
  );

const toAttrs = (
  subscriptionId: string,
  name: string,
  group: {
    id?: string;
    location: string;
    tags?: Record<string, string | undefined>;
  },
): ResourceGroup["Attributes"] => ({
  resourceGroupName: name,
  resourceGroupId:
    group.id ?? `/subscriptions/${subscriptionId}/resourceGroups/${name}`,
  location: group.location,
  tags: userTags(group.tags),
});

export const ResourceGroupProvider = () =>
  Provider.succeed(ResourceGroup, {
    stables: ["resourceGroupName", "resourceGroupId", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* resources
        .ListResourceGroups({
          subscriptionId,
          _filter: "tagName eq 'alchemy::stack'",
        })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListResourceGroups", page),
          ),
        );
      return (page.value ?? [])
        .filter((group) => hasAnyAlchemyTag(group.tags))
        .flatMap((group) =>
          group.name === undefined
            ? []
            : [toAttrs(subscriptionId, group.name, group)],
        );
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.name !== undefined &&
        news.name.toLowerCase() !== output.resourceGroupName.toLowerCase()
      ) {
        return { action: "replace" } as const;
      }
      if (
        news.location !== undefined &&
        news.location.toLowerCase() !== output.location.toLowerCase()
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const name =
        output?.resourceGroupName ?? (yield* createGroupName(id, olds?.name));
      const observed = yield* getGroup(subscriptionId, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(subscriptionId, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      const name =
        news.name ??
        output?.resourceGroupName ??
        (yield* createGroupName(id, undefined));
      // A recorded location wins over the default so changing the profile
      // location never moves (replaces) existing groups.
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);

      // Observe.
      let observed: ObservedResourceGroup | undefined = yield* getGroup(
        subscriptionId,
        name,
      );

      // Ensure. The PUT is an upsert, so a concurrent create is harmless.
      if (observed === undefined) {
        yield* resources.ResourceGroupsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: name,
          location,
          tags,
        });
      } else if (tagsDiffer(observed.tags, tags)) {
        // Sync tags against the observed cloud tags.
        yield* resources.UpdateResourceGroup({
          subscriptionId,
          resourceGroupName: name,
          tags,
        });
      }

      observed = yield* waitForProvisioned(
        `resource group ${name}`,
        getGroup(subscriptionId, name),
        (group) => group.properties?.provisioningState,
      );
      return toAttrs(subscriptionId, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const name = output.resourceGroupName;
      yield* ignoreNotFound(
        resources.DeleteResourceGroup({
          subscriptionId,
          resourceGroupName: name,
        }),
      );
      // Deleting a group deletes its contents, which can take minutes.
      yield* waitUntilGone(
        `resource group ${name}`,
        getGroup(subscriptionId, name),
        { interval: "5 seconds", times: 60 },
      );
    }),
  });
