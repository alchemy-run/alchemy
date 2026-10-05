import * as aci from "@distilled.cloud/azure/containerinstance";
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
  createContainerInstanceName,
  identityMatches,
  lower,
  sameLocation,
} from "./common.ts";

/** Managed identity of a sandbox group. */
export interface SandboxGroupIdentity {
  /** Identity type. */
  type:
    | "None"
    | "SystemAssigned"
    | "UserAssigned"
    | "SystemAssigned,UserAssigned";
  /** ARM IDs of the user-assigned identities to attach. */
  userAssignedIdentities?: string[];
}

export interface SandboxGroupProps {
  /** Resource group the sandbox group is created in. Changing it replaces the sandbox group. */
  resourceGroup: string;
  /**
   * Sandbox group name: 1-63 lowercase letters, digits, and hyphens. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the sandbox group.
   */
  name?: string;
  /**
   * Azure location. Changing it replaces the sandbox group.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /** ARM IDs of subnets the sandboxes are injected into. Changing them replaces the sandbox group. */
  subnetIds?: string[];
  /** Managed identity of the sandbox group. */
  identity?: SandboxGroupIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface SandboxGroup extends Resource<
  "Azure.ContainerInstance.SandboxGroup",
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
    /** ARM ID of the resource group Azure manages for the sandboxes. */
    managementResourceGroupId: string | undefined;
    /** Principal ID of the system-assigned identity, if enabled. */
    principalId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Container Instances sandbox group
 * (`Microsoft.ContainerInstance/sandboxGroups`) — a preview container for
 * isolated, short-lived sandboxes that clients connect to with
 * `ConnectSandboxGroup` access tokens.
 *
 * Deploys block until the sandbox group is provisioned. The API is in
 * preview and not available in every region or subscription.
 *
 * @see https://learn.microsoft.com/azure/container-instances/
 *
 * ### Creating a Sandbox Group
 * **Example:** Sandbox group with a system-assigned identity
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("app");
 * const sandboxes = yield* Azure.ContainerInstance.SandboxGroup("sandboxes", {
 *   resourceGroup: group.resourceGroupName,
 *   identity: { type: "SystemAssigned" },
 * });
 * ```
 *
 * **Example:** VNet-injected sandbox group
 * ```typescript
 * const sandboxes = yield* Azure.ContainerInstance.SandboxGroup("sandboxes", {
 *   resourceGroup: group.resourceGroupName,
 *   subnetIds: [subnet.subnetId],
 * });
 * ```
 *
 * @resource
 */
export const SandboxGroup = Resource<SandboxGroup>(
  "Azure.ContainerInstance.SandboxGroup",
);

/**
 * Sandbox groups are a limited preview: where ARM has not rolled the type
 * out, every call fails with `InvalidResourceType`. No sandbox group can
 * exist there, so reads and deletes treat it as absent; creates surface it.
 */
const getSandboxGroup = (
  subscriptionId: string,
  resourceGroupName: string,
  sandboxGroupName: string,
) =>
  orUndefinedIfNotFound(
    aci.GetSandboxGroup({
      subscriptionId,
      resourceGroupName,
      sandboxGroupName,
    }),
  ).pipe(
    Effect.catchTag("InvalidResourceType", () => Effect.succeed(undefined)),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: Pick<
    aci.GetSandboxGroupResponse,
    "id" | "location" | "properties" | "identity" | "tags"
  >,
): SandboxGroup["Attributes"] => ({
  sandboxGroupName: name,
  sandboxGroupId: observed.id ?? "",
  resourceGroup,
  location: observed.location,
  managementResourceGroupId: observed.properties?.managementResourceGroupId,
  principalId: observed.identity?.principalId,
  tags: userTags(observed.tags),
});

const toIdentity = (identity: SandboxGroupIdentity | undefined) =>
  identity === undefined
    ? undefined
    : {
        type: identity.type,
        userAssignedIdentities:
          identity.userAssignedIdentities !== undefined &&
          identity.userAssignedIdentities.length > 0
            ? Object.fromEntries(
                identity.userAssignedIdentities.map((id) => [id, {}]),
              )
            : undefined,
      };

const sorted = (values: ReadonlyArray<string> | undefined) =>
  (values ?? [])
    .map((v) => v.toLowerCase())
    .sort()
    .join("|");

export const SandboxGroupProvider = () =>
  Provider.succeed(SandboxGroup, {
    stables: [
      "sandboxGroupName",
      "sandboxGroupId",
      "resourceGroup",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* aci
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

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined && news.name !== output.sandboxGroupName) ||
        (news.location !== undefined &&
          !sameLocation(news.location, output.location)) ||
        sorted(news.subnetIds) !== sorted(olds.subnetIds)
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
        output?.sandboxGroupName ??
        olds?.name ??
        (yield* createContainerInstanceName(id));
      const observed = yield* getSandboxGroup(
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
      yield* ensureRegistered(subscriptionId, "Microsoft.ContainerInstance");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.sandboxGroupName ??
        (yield* createContainerInstanceName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const identity = toIdentity(news.identity);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        sandboxGroupName: name,
      };
      const get = getSandboxGroup(subscriptionId, resourceGroup, name);
      const ready = waitForProvisioned(
        `sandbox group ${name}`,
        get,
        (sandboxGroup) => sandboxGroup.properties?.provisioningState,
        { interval: "10 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* aci.SandboxGroupsCreateOrUpdate({
          ...where,
          location,
          tags,
          identity,
          properties:
            news.subnetIds === undefined
              ? undefined
              : {
                  networkProfile: {
                    subnets: news.subnetIds.map((id) => ({ id })),
                  },
                },
        });
      }
      observed = yield* ready;

      // Sync tags and identity (the only mutable aspects) with a PATCH.
      const identityChanged = !identityMatches(
        news.identity,
        observed.identity,
      );
      if (identityChanged || tagsDiffer(observed.tags, tags)) {
        yield* aci.UpdateSandboxGroup({
          ...where,
          tags,
          identity: identityChanged ? identity : undefined,
        });
        observed = yield* ready;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        aci.DeleteSandboxGroup({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          sandboxGroupName: output.sandboxGroupName,
        }),
      ).pipe(Effect.catchTag("InvalidResourceType", () => Effect.void));
      yield* waitUntilGone(
        `sandbox group ${output.sandboxGroupName}`,
        getSandboxGroup(
          subscriptionId,
          output.resourceGroup,
          output.sandboxGroupName,
        ),
        { interval: "10 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
