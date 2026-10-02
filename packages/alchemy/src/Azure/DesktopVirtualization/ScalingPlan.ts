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

/** A host pool the scaling plan applies to. */
export interface ScalingPlanHostPoolReference {
  /** ARM ID of the host pool. */
  hostPoolId: string;
  /**
   * Whether the plan actively scales the host pool. Enabling it needs the
   * `Desktop Virtualization Power On Off Contributor` role for the Azure
   * Virtual Desktop service principal on the host pool's subscription or
   * resource group.
   */
  scalingPlanEnabled: boolean;
}

export interface ScalingPlanProps {
  /** Resource group of the scaling plan. Changing it replaces the plan. */
  resourceGroup: string;
  /**
   * Scaling plan name, 3-64 letters, digits, `@`, `.`, `-`, `_`, or spaces.
   * If omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the plan.
   */
  name?: string;
  /**
   * Azure Virtual Desktop metadata location of the plan. Changing it
   * replaces the plan.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /** Windows time zone the schedules use, e.g. `UTC` or `Pacific Standard Time`. */
  timeZone: string;
  /**
   * Type of host pools the plan scales; schedules must match it
   * (`ScalingPlanPooledSchedule` or `ScalingPlanPersonalSchedule`).
   * Changing it replaces the plan.
   * @default "Pooled"
   */
  hostPoolType?: "Pooled" | "Personal";
  /** Session hosts carrying this tag name are excluded from scaling. */
  exclusionTag?: string;
  /** Display name of the plan. */
  friendlyName?: string;
  /** Description of the plan. */
  description?: string;
  /**
   * Host pools the plan is assigned to. A host pool can be assigned to one
   * scaling plan.
   * @default []
   */
  hostPoolReferences?: ScalingPlanHostPoolReference[];
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface ScalingPlan extends Resource<
  "Azure.DesktopVirtualization.ScalingPlan",
  ScalingPlanProps,
  {
    /** Name of the scaling plan. */
    scalingPlanName: string;
    /** ARM resource ID of the scaling plan. */
    scalingPlanId: string;
    /** Resource group of the scaling plan. */
    resourceGroup: string;
    /** Metadata location of the scaling plan. */
    location: string;
    /** Host pool type the plan scales. */
    hostPoolType: string;
    /** Internal object ID of the scaling plan. */
    objectId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Virtual Desktop scaling plan (autoscale) — starts and stops
 * session hosts on a schedule to match demand. Define its schedules with
 * `ScalingPlanPooledSchedule` or `ScalingPlanPersonalSchedule` and assign
 * it to host pools with `hostPoolReferences`.
 *
 * @see https://learn.microsoft.com/azure/virtual-desktop/autoscale-scaling-plan
 *
 * ### Creating a Scaling Plan
 * **Example:** Pooled scaling plan
 * ```typescript
 * const plan = yield* Azure.DesktopVirtualization.ScalingPlan("autoscale", {
 *   resourceGroup: group.resourceGroupName,
 *   timeZone: "UTC",
 *   exclusionTag: "excludeFromScaling",
 * });
 * ```
 *
 * ### Assigning Host Pools
 * **Example:** Assign a host pool without enabling scaling yet
 * ```typescript
 * const plan = yield* Azure.DesktopVirtualization.ScalingPlan("autoscale", {
 *   resourceGroup: group.resourceGroupName,
 *   timeZone: "UTC",
 *   hostPoolReferences: [
 *     { hostPoolId: pool.hostPoolId, scalingPlanEnabled: false },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const ScalingPlan = Resource<ScalingPlan>(
  "Azure.DesktopVirtualization.ScalingPlan",
);

type ObservedScalingPlan = desktopvirtualization.GetScalingPlanResponse;

export const getScalingPlan = (
  subscriptionId: string,
  resourceGroupName: string,
  scalingPlanName: string,
) =>
  orUndefinedIfNotFound(
    desktopvirtualization.GetScalingPlan({
      subscriptionId,
      resourceGroupName,
      scalingPlanName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  plan: ObservedScalingPlan,
): ScalingPlan["Attributes"] => ({
  scalingPlanName: name,
  scalingPlanId: plan.id ?? "",
  resourceGroup,
  location: plan.location,
  hostPoolType: plan.properties?.hostPoolType ?? "Pooled",
  objectId: plan.properties?.objectId,
  tags: userTags(plan.tags),
});

const toReferences = (references: ScalingPlanHostPoolReference[]) =>
  references.map((reference) => ({
    hostPoolArmPath: reference.hostPoolId,
    scalingPlanEnabled: reference.scalingPlanEnabled,
  }));

export const ScalingPlanProvider = () =>
  Provider.succeed(ScalingPlan, {
    stables: [
      "scalingPlanName",
      "scalingPlanId",
      "resourceGroup",
      "location",
      "hostPoolType",
      "objectId",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* desktopvirtualization
        .ListScalingPlanBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListScalingPlanBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((plan) => {
        const rg = resourceGroupOf(plan.id);
        return hasAnyAlchemyTag(plan.tags) &&
          rg !== undefined &&
          plan.name !== undefined
          ? [toAttrs(rg, plan.name, plan)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.scalingPlanName.toLowerCase()) ||
        (news.location !== undefined &&
          news.location.toLowerCase() !== output.location.toLowerCase()) ||
        (news.hostPoolType ?? "Pooled").toLowerCase() !==
          output.hostPoolType.toLowerCase()
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
        output?.scalingPlanName ?? olds?.name ?? (yield* createAvdName(id, 64));
      const observed = yield* getScalingPlan(
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
        news.name ?? output?.scalingPlanName ?? (yield* createAvdName(id, 64));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const desired = {
        timeZone: news.timeZone,
        exclusionTag: news.exclusionTag,
        friendlyName: news.friendlyName,
        description: news.description,
        hostPoolReferences: toReferences(news.hostPoolReferences ?? []),
      };
      const request = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        scalingPlanName: name,
      };

      // Observe.
      let observed: ObservedScalingPlan | undefined = yield* getScalingPlan(
        subscriptionId,
        resourceGroup,
        name,
      );

      if (observed === undefined) {
        // Ensure: the PUT is synchronous. Schedules are child resources.
        observed = yield* desktopvirtualization.CreateScalingPlan({
          ...request,
          location,
          tags,
          properties: {
            ...desired,
            hostPoolType: news.hostPoolType ?? "Pooled",
          },
        });
      } else {
        // Sync: PATCH only the observed deltas.
        const delta = deltaOf(desired, {
          ...observed.properties,
          hostPoolReferences: observed.properties?.hostPoolReferences ?? [],
        });
        const tagsChanged = tagsDiffer(observed.tags, tags);
        if (delta !== undefined || tagsChanged) {
          observed = yield* desktopvirtualization.UpdateScalingPlan({
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
        desktopvirtualization.DeleteScalingPlan({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          scalingPlanName: output.scalingPlanName,
        }),
      );
      yield* waitUntilGone(
        `scaling plan ${output.scalingPlanName}`,
        getScalingPlan(
          subscriptionId,
          output.resourceGroup,
          output.scalingPlanName,
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
