import * as resources from "@distilled.cloud/azure/resources";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  collectAll,
  desiredTags,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  stackAndStage,
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
   * in `.`. If omitted, a unique name of at most 80 characters (the limit
   * Front Door accepts) is generated from the app, stage, and logical ID.
   * Changing it replaces the resource group.
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
  /**
   * Refuse to delete the group while it still holds resources. Destroy then
   * deletes the group only when it carries this stack's ownership tags and
   * is empty, and fails with `Azure.ResourceGroupNotEmpty` or
   * `Azure.ResourceGroupNotOwned` otherwise. The stack's implicit
   * `<stack>-<stage>` group sets this. `alchemy unsafe nuke` ignores it.
   * @default false
   */
  deleteOnlyIfEmpty?: boolean;
}

/** Destroy found resources in a `deleteOnlyIfEmpty` group. */
export class ResourceGroupNotEmpty extends Data.TaggedError("Azure.ResourceGroupNotEmpty")<{
  readonly resourceGroup: string;
  /** ARM IDs of the resources still in the group. */
  readonly resources: readonly string[];
  readonly message: string;
}> {}

/** Destroy found a `deleteOnlyIfEmpty` group without this stack's ownership tags. */
export class ResourceGroupNotOwned extends Data.TaggedError("Azure.ResourceGroupNotOwned")<{
  readonly resourceGroup: string;
  readonly message: string;
}> {}

/** The deploying identity may not create resource groups in the subscription. */
export class ResourceGroupCreateForbidden extends Data.TaggedError(
  "Azure.ResourceGroupCreateForbidden",
)<{
  readonly resourceGroup: string;
  readonly message: string;
}> {}

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
 * You rarely declare one. A resource without a `resourceGroup` prop goes
 * into the stack's resource group: `<stack>-<stage>`, created on first use
 * and deleted on destroy once it is empty. Declare a group to choose its
 * name, location, or tags, or to keep shared resources apart.
 *
 * @see https://learn.microsoft.com/azure/azure-resource-manager/management/manage-resource-groups-portal
 *
 * ### Using the Stack's Resource Group
 * **Example:** Resources go into `<stack>-<stage>` by default
 * ```typescript
 * // Created in the resource group "shop-prod" for stack "shop", stage "prod".
 * const account = yield* Azure.Storage.StorageAccount("files");
 * ```
 *
 * **Example:** Deploy into an existing resource group
 * ```typescript
 * // Alchemy references "rg-shop-prod" and never creates or deletes it.
 * providers: Azure.providers().pipe(
 *   Layer.provideMerge(Azure.resourceGroup("rg-shop-prod")),
 * ),
 * ```
 *
 * **Example:** Manage the stack's resource group yourself
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("app", {
 *   name: "shop-prod",
 *   location: "westeurope",
 *   tags: { team: "shop" },
 * });
 * yield* Effect.gen(function* () {
 *   yield* Azure.Storage.StorageAccount("files");
 * }).pipe(Effect.provide(Azure.resourceGroup(group)));
 * ```
 *
 * :::caution
 * A resource's ARM ID contains its resource group. Moving a resource to
 * another group, or switching the stack from the default group to a named
 * one, replaces the resource.
 * :::
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
export const ResourceGroup = Resource<ResourceGroup>("Azure.Resources.ResourceGroup");

type ObservedResourceGroup = resources.GetResourceGroupResponse;

// ARM allows 90 characters, but Front Door rejects resource groups longer
// than 80, so generated names stay within 80.
const createGroupName = (id: string, name: string | undefined) =>
  name !== undefined ? Effect.succeed(name) : createPhysicalName({ id, maxLength: 80 });

const getGroup = (subscriptionId: string, resourceGroupName: string) =>
  orUndefinedIfNotFound(resources.GetResourceGroup({ subscriptionId, resourceGroupName }));

/**
 * Fail unless the group holds no resources. ARM's resource list lags the
 * deletes that destroy just finished, so poll for up to a minute, and for
 * up to 15 minutes while everything still listed carries this stack's
 * ownership tags: a deleted Durable Task Scheduler stays listed for 5-15.
 */
const requireEmpty = (subscriptionId: string, resourceGroupName: string) =>
  Effect.gen(function* () {
    const { stack, stage } = yield* stackAndStage;
    const list = orUndefinedIfNotFound(
      resources.ListResourceByResourceGroup({ subscriptionId, resourceGroupName, _top: 50 }),
    ).pipe(Effect.map((page) => page?.value ?? []));
    const ours = (listed: ReadonlyArray<{ tags?: Record<string, string | undefined> }>) =>
      listed.every(
        (r) => r.tags?.["alchemy::stack"] === stack && r.tags?.["alchemy::stage"] === stage,
      );
    const listed = yield* list.pipe(
      Effect.repeat({
        until: (all) => all.length === 0,
        schedule: Schedule.spaced("5 seconds"),
        times: 12,
      }),
      Effect.flatMap((all) =>
        all.length > 0 && ours(all)
          ? list.pipe(
              Effect.repeat({
                until: (now) => now.length === 0 || !ours(now),
                schedule: Schedule.spaced("90 seconds"),
                times: 10,
              }),
            )
          : Effect.succeed(all),
      ),
    );
    const remaining = listed.flatMap((r) => (r.id ? [r.id] : []));
    if (remaining.length > 0) {
      return yield* new ResourceGroupNotEmpty({
        resourceGroup: resourceGroupName,
        resources: remaining,
        message:
          `Resource group '${resourceGroupName}' still holds resources Alchemy did not create, ` +
          `so Alchemy will not delete it: ${remaining.join(", ")}. Delete or move them, then destroy again.`,
      });
    }
  });

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
  resourceGroupId: group.id ?? `/subscriptions/${subscriptionId}/resourceGroups/${name}`,
  location: group.location,
  tags: userTags(group.tags),
});

export const ResourceGroupProvider = () =>
  Provider.succeed(ResourceGroup, {
    stables: ["resourceGroupName", "resourceGroupId", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* collectAll(resources.ListResourceGroups, {
        subscriptionId,
        _filter: "tagName eq 'alchemy::stack'",
      });
      return (page.value ?? [])
        .filter((group) => hasAnyAlchemyTag(group.tags))
        .flatMap((group) =>
          group.name === undefined ? [] : [toAttrs(subscriptionId, group.name, group)],
        );
    }),

    diff: Effect.fn(function* ({ news = {}, output }) {
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
      const name = output?.resourceGroupName ?? (yield* createGroupName(id, olds?.name));
      const observed = yield* getGroup(subscriptionId, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(subscriptionId, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news = {}, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      const name =
        news.name ?? output?.resourceGroupName ?? (yield* createGroupName(id, undefined));
      // A recorded location wins over the default so changing the profile
      // location never moves (replaces) existing groups.
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);

      // Observe.
      let observed: ObservedResourceGroup | undefined = yield* getGroup(subscriptionId, name);

      // Ensure. The PUT is an upsert, so a concurrent create is harmless.
      if (observed === undefined) {
        yield* resources
          .ResourceGroupsCreateOrUpdate({
            subscriptionId,
            resourceGroupName: name,
            location,
            tags,
          })
          .pipe(
            Effect.catchTag("AuthorizationFailed", (error) =>
              Effect.fail(
                new ResourceGroupCreateForbidden({
                  resourceGroup: name,
                  message:
                    `The deploying identity may not create resource group '${name}' ` +
                    `(${error.message ?? "AuthorizationFailed"}). Deploy into an existing ` +
                    `group instead: provide Azure.resourceGroup("<name>") on the stack's ` +
                    `providers, or pass resourceGroup on each resource.`,
                }),
              ),
            ),
          );
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

    delete: Effect.fn(function* ({ id, olds, output, force }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const name = output.resourceGroupName;
      if (olds?.deleteOnlyIfEmpty === true && force !== true) {
        const observed = yield* getGroup(subscriptionId, name);
        if (observed === undefined) return;
        if (!(yield* isOwned(id, observed.tags))) {
          return yield* new ResourceGroupNotOwned({
            resourceGroup: name,
            message: `Resource group '${name}' lacks this stack's ownership tags; Alchemy will not delete it.`,
          });
        }
        yield* requireEmpty(subscriptionId, name);
      }
      yield* ignoreNotFound(
        resources.DeleteResourceGroup({
          subscriptionId,
          resourceGroupName: name,
        }),
      );
      // Deleting a group deletes its contents, which can take minutes.
      yield* waitUntilGone(`resource group ${name}`, getGroup(subscriptionId, name), {
        interval: "5 seconds",
        times: 60,
      });
    }),
  });
