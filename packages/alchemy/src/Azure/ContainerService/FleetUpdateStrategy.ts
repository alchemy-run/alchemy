import * as cs from "@distilled.cloud/azure/containerservice";
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
import {
  createChildName,
  isFleetOwned,
  sameName,
  subsetMatches,
  whileFleetBusy,
} from "./Common.ts";

export interface FleetUpdateGroup {
  /** Name of the member group (matches `FleetMember.group`). */
  name: string;
  /** Maximum members of the group updated at once, e.g. `"1"` or `"25%"`. */
  maxConcurrency?: string;
}

export interface FleetUpdateStage {
  /** Name of the stage, unique within the strategy. */
  name: string;
  /** Member groups updated in this stage. */
  groups?: FleetUpdateGroup[];
  /** Seconds to wait after the stage before starting the next one. */
  afterStageWaitInSeconds?: number;
  /** Maximum groups of the stage updated at once, e.g. `"1"` or `"50%"`. */
  maxConcurrency?: string;
}

export interface FleetUpdateStrategyProps {
  /** Resource group of the fleet. Changing it replaces the strategy. */
  resourceGroup: string;
  /** Name of the fleet. Changing it replaces the strategy. */
  fleet: string;
  /**
   * Strategy name: 1-50 lowercase letters, digits, and hyphens. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the strategy.
   */
  name?: string;
  /** Stages executed in order by update runs using this strategy. */
  stages: FleetUpdateStage[];
}

export interface FleetUpdateStrategy extends Resource<
  "Azure.ContainerService.FleetUpdateStrategy",
  FleetUpdateStrategyProps,
  {
    /** Name of the strategy. */
    updateStrategyName: string;
    /** ARM resource ID of the strategy (use as `updateStrategyId`). */
    updateStrategyId: string;
    /** Name of the fleet. */
    fleet: string;
    /** Resource group of the fleet. */
    resourceGroup: string;
    /** Names of the observed stages, in order. */
    stageNames: string[];
  },
  never,
  Providers
> {}

/**
 * A reusable staged rollout plan for fleet update runs and auto-upgrade
 * profiles: stages run in order, each updating one or more member groups.
 *
 * Strategies cannot be tagged; ownership follows the fleet's Alchemy tags.
 *
 * @see https://learn.microsoft.com/azure/kubernetes-fleet/update-orchestration
 *
 * ### Defining a Rollout
 * **Example:** Staging first, then production after an hour
 * ```typescript
 * const strategy = yield* Azure.ContainerService.FleetUpdateStrategy("rollout", {
 *   resourceGroup: group.resourceGroupName,
 *   fleet: fleet.fleetName,
 *   stages: [
 *     { name: "staging", groups: [{ name: "staging" }], afterStageWaitInSeconds: 3600 },
 *     { name: "production", groups: [{ name: "production" }] },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const FleetUpdateStrategy = Resource<FleetUpdateStrategy>(
  "Azure.ContainerService.FleetUpdateStrategy",
);

type ObservedStrategy = cs.GetFleetUpdateStrategyResponse;

const createStrategyName = (id: string) => createChildName(id, 50);

const getStrategy = (
  subscriptionId: string,
  resourceGroupName: string,
  fleetName: string,
  updateStrategyName: string,
) =>
  orUndefinedIfNotFound(
    cs.GetFleetUpdateStrategy({
      subscriptionId,
      resourceGroupName,
      fleetName,
      updateStrategyName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  fleet: string,
  name: string,
  strategy: ObservedStrategy,
): FleetUpdateStrategy["Attributes"] => ({
  updateStrategyName: name,
  updateStrategyId: strategy.id ?? "",
  fleet,
  resourceGroup,
  stageNames: (strategy.properties?.strategy.stages ?? []).map(
    (stage) => stage.name,
  ),
});

/** Stages as sent to ARM, with omitted lists normalized to `[]`. */
const normalizeStages = (stages: FleetUpdateStage[]): cs.UpdateStage[] =>
  stages.map((stage) => ({
    name: stage.name,
    groups: (stage.groups ?? []).map((group) => ({
      name: group.name,
      maxConcurrency: group.maxConcurrency,
    })),
    afterStageWaitInSeconds: stage.afterStageWaitInSeconds,
    maxConcurrency: stage.maxConcurrency,
  }));

const stateOf = (strategy: ObservedStrategy) =>
  strategy.properties?.provisioningState;

export const FleetUpdateStrategyProvider = () =>
  Provider.succeed(FleetUpdateStrategy, {
    stables: [
      "updateStrategyName",
      "updateStrategyId",
      "fleet",
      "resourceGroup",
    ],

    // Strategies live inside a fleet; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.fleet, output.fleet) ||
        (news.name !== undefined && news.name !== output.updateStrategyName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const fleet = output?.fleet ?? olds?.fleet;
      if (resourceGroup === undefined || fleet === undefined) return undefined;
      const name =
        output?.updateStrategyName ??
        olds?.name ??
        (yield* createStrategyName(id));
      const observed = yield* getStrategy(
        subscriptionId,
        resourceGroup,
        fleet,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, fleet, name, observed);
      return (yield* isFleetOwned(subscriptionId, resourceGroup, fleet))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.ContainerService");
      const { resourceGroup, fleet } = news;
      const name =
        news.name ??
        output?.updateStrategyName ??
        (yield* createStrategyName(id));
      const stages = normalizeStages(news.stages);
      const get = getStrategy(subscriptionId, resourceGroup, fleet, name);

      // Observe, then PUT the full strategy only on drift.
      const observed = yield* get;
      if (
        observed === undefined ||
        !subsetMatches(stages, observed.properties?.strategy.stages)
      ) {
        yield* cs
          .FleetUpdateStrategiesCreateOrUpdate({
            subscriptionId,
            resourceGroupName: resourceGroup,
            fleetName: fleet,
            updateStrategyName: name,
            properties: { strategy: { stages } },
          })
          .pipe(Effect.retry(whileFleetBusy));
      }

      const fresh = yield* waitForProvisioned(
        `fleet update strategy ${fleet}/${name}`,
        get,
        stateOf,
        { interval: "3 seconds", times: 40 },
      );
      return toAttrs(resourceGroup, fleet, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        cs
          .DeleteFleetUpdateStrategy({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            fleetName: output.fleet,
            updateStrategyName: output.updateStrategyName,
          })
          .pipe(Effect.retry(whileFleetBusy)),
      );
      yield* waitUntilGone(
        `fleet update strategy ${output.fleet}/${output.updateStrategyName}`,
        getStrategy(
          subscriptionId,
          output.resourceGroup,
          output.fleet,
          output.updateStrategyName,
        ),
      );
    }),
  });
