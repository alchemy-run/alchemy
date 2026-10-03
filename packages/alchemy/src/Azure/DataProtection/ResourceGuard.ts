import * as dataprotection from "@distilled.cloud/azure/dataprotection";
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
import { NAMESPACE, sameText } from "./Common.ts";

export interface ResourceGuardProps {
  /** Resource group the guard is created in. Changing it replaces the guard. */
  resourceGroup: string;
  /**
   * Guard name. If omitted, a unique name is generated from the app, stage,
   * and logical ID. Changing it replaces the guard.
   */
  name?: string;
  /**
   * Azure location of the guard. Changing it replaces the guard.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Critical operations the guard does NOT protect, e.g.
   * `Microsoft.DataProtection/backupVaults/backupResourceGuardProxies/delete`
   * or `Microsoft.DataProtection/backupVaults/backupInstances/delete`.
   * Every other critical operation needs the guard owner's approval.
   * @default []
   */
  vaultCriticalOperationExclusionList?: string[];
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface ResourceGuard extends Resource<
  "Azure.DataProtection.ResourceGuard",
  ResourceGuardProps,
  {
    /** Name of the guard. */
    resourceGuardName: string;
    /** ARM resource ID of the guard; reference it from a {@link ResourceGuardProxy}. */
    resourceGuardId: string;
    /** Resource group that holds the guard. */
    resourceGroup: string;
    /** Location of the guard. */
    location: string;
    /** Critical operations the guard does not protect. */
    vaultCriticalOperationExclusionList: string[];
    /** Critical operations the guard protects (read-only, set by Azure). */
    resourceGuardOperations: string[];
    /** Whether auto approvals are allowed. */
    allowAutoApprovals: boolean;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Backup resource guard (`Microsoft.DataProtection/resourceGuards`)
 * — multi-user authorization (MUA) for Backup vaults. Once a vault is
 * linked to the guard with a {@link ResourceGuardProxy}, its critical
 * operations (disabling soft delete, deleting backup instances, removing
 * the proxy, …) require permissions on the guard, which usually lives in a
 * security team's resource group or subscription.
 *
 * @see https://learn.microsoft.com/azure/backup/multi-user-authorization-concept
 *
 * ### Creating a Resource Guard
 * **Example:** Guard protecting every critical operation
 * ```typescript
 * const guard = yield* Azure.DataProtection.ResourceGuard("guard", {
 *   resourceGroup: securityGroup.resourceGroupName,
 * });
 * ```
 *
 * **Example:** Guard that lets the proxy be removed without approval
 * ```typescript
 * const guard = yield* Azure.DataProtection.ResourceGuard("guard", {
 *   resourceGroup: securityGroup.resourceGroupName,
 *   vaultCriticalOperationExclusionList: [
 *     "Microsoft.DataProtection/backupVaults/backupResourceGuardProxies/delete",
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const ResourceGuard = Resource<ResourceGuard>(
  "Azure.DataProtection.ResourceGuard",
);

type ObservedGuard = dataprotection.GetResourceGuardResponse;

const createGuardName = Effect.fn(function* (id: string) {
  return yield* createPhysicalName({ id, maxLength: 50 });
});

const getGuard = (
  subscriptionId: string,
  resourceGroupName: string,
  resourceGuardsName: string,
) =>
  orUndefinedIfNotFound(
    dataprotection.GetResourceGuard({
      subscriptionId,
      resourceGroupName,
      resourceGuardsName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  guard: ObservedGuard,
): ResourceGuard["Attributes"] => ({
  resourceGuardName: name,
  resourceGuardId: guard.id ?? "",
  resourceGroup,
  location: guard.location,
  vaultCriticalOperationExclusionList: [
    ...(guard.properties?.vaultCriticalOperationExclusionList ?? []),
  ],
  resourceGuardOperations: (guard.properties?.resourceGuardOperations ?? [])
    .map((op) => op.vaultCriticalOperation)
    .filter((op): op is string => op !== undefined),
  allowAutoApprovals: guard.properties?.allowAutoApprovals ?? false,
  tags: userTags(guard.tags),
});

const listKey = (list: readonly string[] | undefined) =>
  [...(list ?? [])]
    .map((s) => s.toLowerCase())
    .sort()
    .join(",");

export const ResourceGuardProvider = () =>
  Provider.succeed(ResourceGuard, {
    stables: [
      "resourceGuardName",
      "resourceGuardId",
      "resourceGroup",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* dataprotection
        .GetResourceGuardResourcesInSubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("GetResourceGuardResourcesInSubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((guard) => {
        const group = resourceGroupOf(guard.id);
        return hasAnyAlchemyTag(guard.tags) &&
          group !== undefined &&
          guard.name !== undefined
          ? [
              toAttrs(group, guard.name, {
                ...guard,
                location: guard.location ?? "",
              } as ObservedGuard),
            ]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameText(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && news.name !== output.resourceGuardName) ||
        (news.location !== undefined &&
          !sameText(
            news.location.replaceAll(" ", ""),
            output.location.replaceAll(" ", ""),
          ))
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
        output?.resourceGuardName ?? olds?.name ?? (yield* createGuardName(id));
      const observed = yield* getGuard(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, NAMESPACE);
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.resourceGuardName ?? (yield* createGuardName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const exclusions = news.vaultCriticalOperationExclusionList ?? [];
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        resourceGuardsName: name,
      };
      const get = getGuard(subscriptionId, resourceGroup, name);

      // Observe.
      let observed = yield* get;

      // Ensure + sync the exclusion list: PUT is a synchronous upsert, sent
      // only when the guard is missing or its exclusion list drifted.
      if (
        observed === undefined ||
        listKey(observed.properties?.vaultCriticalOperationExclusionList) !==
          listKey(exclusions)
      ) {
        yield* dataprotection.PutResourceGuard({
          ...where,
          location: observed?.location ?? location,
          tags,
          properties: { vaultCriticalOperationExclusionList: exclusions },
        });
        observed = yield* get;
      }

      // Sync tags against observed tags.
      if (observed !== undefined && tagsDiffer(observed.tags, tags)) {
        yield* dataprotection.PatchResourceGuard({ ...where, tags });
      }

      observed = yield* waitForProvisioned(
        `resource guard ${name}`,
        get,
        (guard) => guard.properties?.provisioningState,
        { interval: "2 seconds", times: 30 },
      );
      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        dataprotection.DeleteResourceGuard({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          resourceGuardsName: output.resourceGuardName,
        }),
      );
      yield* waitUntilGone(
        `resource guard ${output.resourceGuardName}`,
        getGuard(
          subscriptionId,
          output.resourceGroup,
          output.resourceGuardName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
