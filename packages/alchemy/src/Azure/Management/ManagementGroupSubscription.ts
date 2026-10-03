import * as management from "@distilled.cloud/azure/management";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { managementGroupNameOf } from "./ManagementGroup.ts";

export interface ManagementGroupSubscriptionProps {
  /**
   * Management group to place the subscription under: its ARM ID or name,
   * e.g. `group.managementGroupId`. Changing it replaces the association
   * (the subscription is moved to the new group).
   */
  managementGroupId: string;
  /**
   * Subscription to move under the group. Changing it replaces the
   * association.
   * @default the subscription of the current Azure environment
   */
  subscriptionId?: string;
}

export interface ManagementGroupSubscription extends Resource<
  "Azure.Management.ManagementGroupSubscription",
  ManagementGroupSubscriptionProps,
  {
    /** Name of the management group holding the subscription. */
    groupName: string;
    /** Subscription ID. */
    subscriptionId: string;
    /**
     * ARM ID of the association,
     * `/providers/Microsoft.Management/managementGroups/{group}/subscriptions/{id}`.
     */
    associationId: string;
    /** Friendly name of the subscription. */
    displayName: string | undefined;
    /** Subscription state, e.g. `Active`. */
    state: string | undefined;
    /** Microsoft Entra tenant of the subscription. */
    tenantId: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Places a subscription under a management group, so the group's policies
 * and role assignments apply to it.
 *
 * A subscription belongs to exactly one management group. Creating this
 * resource moves the subscription out of its current group; deleting it
 * moves the subscription back to the tenant root group. The deploying
 * identity needs Owner on the subscription and
 * `Microsoft.Management/managementGroups/write` on the target group.
 *
 * @see https://learn.microsoft.com/azure/governance/management-groups/manage#move-management-groups-and-subscriptions
 *
 * ### Organizing Subscriptions
 * **Example:** Move the current subscription under a management group
 * ```typescript
 * const platform = yield* Azure.Management.ManagementGroup("platform", {
 *   displayName: "Platform",
 * });
 * yield* Azure.Management.ManagementGroupSubscription("platform-sub", {
 *   managementGroupId: platform.managementGroupId,
 * });
 * ```
 *
 * **Example:** Move a specific subscription
 * ```typescript
 * yield* Azure.Management.ManagementGroupSubscription("prod-sub", {
 *   managementGroupId: platform.managementGroupId,
 *   subscriptionId: "00000000-0000-0000-0000-000000000000",
 * });
 * ```
 *
 * @resource
 */
export const ManagementGroupSubscription =
  Resource<ManagementGroupSubscription>(
    "Azure.Management.ManagementGroupSubscription",
  );

/**
 * The subscription's association with `groupId`, or `undefined` when the
 * subscription sits under another group. Checking the observed parent keeps
 * a stale association (e.g. the old side of a replacement) from moving the
 * subscription back to the root on delete.
 */
const getAssociation = (groupId: string, subscriptionId: string) =>
  orUndefinedIfNotFound(
    management
      .GetManagementGroupSubscriptionSubscription({ groupId, subscriptionId })
      .pipe(
        Effect.catchTag("ManagementGroupNotFound", () =>
          Effect.succeed(undefined),
        ),
      ),
  ).pipe(
    Effect.map((observed) => {
      const parent = observed?.properties?.parent?.id;
      return parent === undefined ||
        managementGroupNameOf(parent).toLowerCase() === groupId.toLowerCase()
        ? observed
        : undefined;
    }),
  );

const toAttrs = (
  groupName: string,
  subscriptionId: string,
  observed: management.GetManagementGroupSubscriptionSubscriptionResponse,
): ManagementGroupSubscription["Attributes"] => ({
  groupName,
  subscriptionId,
  associationId:
    observed.id ??
    `/providers/Microsoft.Management/managementGroups/${groupName}/subscriptions/${subscriptionId}`,
  displayName: observed.properties?.displayName,
  state: observed.properties?.state,
  tenantId: observed.properties?.tenant,
});

export const ManagementGroupSubscriptionProvider = () =>
  Provider.succeed(ManagementGroupSubscription, {
    stables: ["groupName", "subscriptionId", "associationId"],

    // Associations carry no ownership marker and listing them needs read
    // access on every management group, so there is no `list`.

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      if (!isResolved(news)) {
        // An unresolved group means the group is being replaced.
        return "managementGroupId" in news &&
          isResolved(news.managementGroupId)
          ? undefined
          : ({ action: "replace" } as const);
      }
      if (
        managementGroupNameOf(news.managementGroupId).toLowerCase() !==
          output.groupName.toLowerCase() ||
        (news.subscriptionId !== undefined &&
          news.subscriptionId.toLowerCase() !==
            output.subscriptionId.toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const env = yield* AzureEnvironment.current;
      const groupId =
        output?.groupName ??
        (olds?.managementGroupId !== undefined
          ? managementGroupNameOf(olds.managementGroupId)
          : undefined);
      // An interrupted create can persist props with unresolved holes.
      if (groupId === undefined) return undefined;
      const subscriptionId =
        output?.subscriptionId ?? olds?.subscriptionId ?? env.subscriptionId;
      const observed = yield* getAssociation(groupId, subscriptionId);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(groupId, subscriptionId, observed);
      // Associations carry no marker; only a recorded one is ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const env = yield* AzureEnvironment.current;
      yield* ensureRegistered(env.subscriptionId, "Microsoft.Management");
      const groupId = managementGroupNameOf(news.managementGroupId);
      const subscriptionId = news.subscriptionId ?? env.subscriptionId;

      // Observe.
      let observed = yield* getAssociation(groupId, subscriptionId);

      // Ensure: existence-only; the PUT moves the subscription.
      if (observed === undefined) {
        yield* management.CreateManagementGroupSubscription({
          groupId,
          subscriptionId,
        });
        observed = yield* waitForProvisioned(
          `subscription ${subscriptionId} under management group ${groupId}`,
          getAssociation(groupId, subscriptionId),
          () => undefined,
          { interval: "5 seconds", times: 36 },
        );
      }

      return toAttrs(groupId, subscriptionId, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      // Moves the subscription back to the tenant root group — only when it
      // is still under this group.
      const observed = yield* getAssociation(
        output.groupName,
        output.subscriptionId,
      );
      if (observed === undefined) return;
      yield* ignoreNotFound(
        management.DeleteManagementGroupSubscription({
          groupId: output.groupName,
          subscriptionId: output.subscriptionId,
        }),
      );
      yield* waitUntilGone(
        `subscription ${output.subscriptionId} under management group ${output.groupName}`,
        getAssociation(output.groupName, output.subscriptionId),
        { interval: "5 seconds", times: 36 },
      );
    }),
  });
