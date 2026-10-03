import * as app from "@distilled.cloud/azure/app";
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
import { createContainerAppsName, lower, sameLocation } from "./common.ts";

export interface SandboxGroupProps {
  /** Resource group the sandbox group is created in. Changing it replaces the group. */
  resourceGroup: string;
  /**
   * Sandbox group name: lowercase letters, digits, and hyphens. If omitted,
   * a unique name is generated from the app, stage, and logical ID.
   * Changing it replaces the group.
   */
  name?: string;
  /**
   * Azure location. Changing it replaces the group.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM ID of a Container Apps environment to link; sandbox endpoints then
   * use subdomains of its default domain. A link can be added later but
   * never changed or removed, so changing or removing it replaces the
   * group.
   */
  environmentId?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface SandboxGroup extends Resource<
  "Azure.ContainerApps.SandboxGroup",
  SandboxGroupProps,
  {
    /** Name of the sandbox group. */
    sandboxGroupName: string;
    /** ARM resource ID of the sandbox group. */
    sandboxGroupId: string;
    /** Resource group that holds the sandbox group. */
    resourceGroup: string;
    /** Location of the sandbox group. */
    location: string;
    /** ARM ID of the linked environment, if any. */
    environmentId: string | undefined;
    /** Default domain of the linked environment, if any. */
    defaultDomain: string | undefined;
    /** Regional data-plane endpoint for managing sandboxes. */
    managementEndpoint: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Container Apps sandbox group (`Microsoft.App/sandboxGroups`) —
 * a regional container for short-lived, isolated sandboxes created through
 * its management endpoint. Optionally linked to a Container Apps
 * environment for networking and domains.
 *
 * The group itself is free; sandboxes are billed while they run.
 *
 * ### Creating a Sandbox Group
 * **Example:** Standalone sandbox group
 * ```typescript
 * const sandboxes = yield* Azure.ContainerApps.SandboxGroup("sandboxes", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * // manage sandboxes through sandboxes.managementEndpoint
 * ```
 *
 * **Example:** Sandbox group linked to an environment
 * ```typescript
 * yield* Azure.ContainerApps.SandboxGroup("sandboxes", {
 *   resourceGroup: group.resourceGroupName,
 *   location: env.location,
 *   environmentId: env.environmentId,
 * });
 * ```
 *
 * @resource
 */
export const SandboxGroup = Resource<SandboxGroup>(
  "Azure.ContainerApps.SandboxGroup",
);

const createGroupName = (id: string) => createContainerAppsName(id, 32);

const getGroup = (
  subscriptionId: string,
  resourceGroupName: string,
  sandboxGroupName: string,
) =>
  orUndefinedIfNotFound(
    app.GetSandboxGroup({
      subscriptionId,
      resourceGroupName,
      sandboxGroupName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: app.GetSandboxGroupResponse,
): SandboxGroup["Attributes"] => ({
  sandboxGroupName: name,
  sandboxGroupId: observed.id ?? "",
  resourceGroup,
  location: observed.location,
  environmentId: observed.properties?.environmentId,
  defaultDomain: observed.properties?.defaultDomain,
  managementEndpoint: observed.properties?.managementEndpoint,
  tags: userTags(observed.tags),
});

export const SandboxGroupProvider = () =>
  Provider.succeed(SandboxGroup, {
    stables: [
      "sandboxGroupName",
      "sandboxGroupId",
      "resourceGroup",
      "location",
      "managementEndpoint",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* app
        .ListSandboxGroupBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListSandboxGroupBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((observed) => {
        const group = resourceGroupOf(observed.id);
        return hasAnyAlchemyTag(observed.tags) &&
          group !== undefined &&
          observed.name !== undefined
          ? [toAttrs(group, observed.name, observed)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined && news.name !== output.sandboxGroupName) ||
        (news.location !== undefined &&
          !sameLocation(news.location, output.location)) ||
        // A linked environment can be added, never changed or removed.
        (output.environmentId !== undefined &&
          lower(news.environmentId) !== lower(output.environmentId))
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
        output?.sandboxGroupName ?? olds?.name ?? (yield* createGroupName(id));
      const observed = yield* getGroup(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.App");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.sandboxGroupName ?? (yield* createGroupName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        sandboxGroupName: name,
      };
      const get = getGroup(subscriptionId, resourceGroup, name);
      const ready = waitForProvisioned(
        `sandbox group ${name}`,
        get,
        (group) => group.properties?.provisioningState,
        { interval: "3 seconds", times: 40 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* app.SandboxGroupsCreateOrUpdate({
          ...where,
          location,
          tags,
          properties:
            news.environmentId === undefined
              ? undefined
              : { environmentId: news.environmentId },
        });
      }
      observed = yield* ready;

      // Sync tags and a newly added environment link via PATCH.
      const linkEnvironment =
        news.environmentId !== undefined &&
        lower(news.environmentId) !== lower(observed.properties?.environmentId);
      if (linkEnvironment || tagsDiffer(observed.tags, tags)) {
        yield* app.UpdateSandboxGroup({
          ...where,
          tags,
          properties: linkEnvironment
            ? { environmentId: news.environmentId }
            : undefined,
        });
        observed = yield* ready;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        app.DeleteSandboxGroup({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          sandboxGroupName: output.sandboxGroupName,
        }),
      );
      yield* waitUntilGone(
        `sandbox group ${output.sandboxGroupName}`,
        getGroup(subscriptionId, output.resourceGroup, output.sandboxGroupName),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.ContainerApps.ManagedEnvironment",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
