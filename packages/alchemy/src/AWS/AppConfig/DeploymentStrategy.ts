import * as appconfig from "@distilled.cloud/aws/appconfig";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  deploymentStrategyArn,
  readAppConfigTags,
  syncAppConfigTags,
} from "./internal.ts";

export interface DeploymentStrategyProps {
  /**
   * Name of the deployment strategy. Must be 1-64 characters. If omitted, a
   * deterministic physical name is generated. Changing the name replaces the
   * strategy.
   */
  deploymentStrategyName?: string;
  /**
   * Total amount of time over which the deployment rolls the configuration
   * out to targets (e.g. `"10 minutes"` or `Duration.minutes(10)`; a bare
   * number is milliseconds). Rounded to whole minutes on the wire.
   */
  deploymentDurationInMinutes: Duration.Input;
  /**
   * Percentage of targets to receive a deployed configuration during each
   * interval.
   */
  growthFactor: number;
  /**
   * How growth is applied over the deployment. `LINEAR` grows by
   * `growthFactor` each interval; `EXPONENTIAL` follows `2^(N*growthFactor)`.
   * @default "LINEAR"
   */
  growthType?: "LINEAR" | "EXPONENTIAL";
  /**
   * Amount of time AppConfig monitors for alarms before considering the
   * deployment complete (e.g. `"5 minutes"`). Rounded to whole minutes on
   * the wire.
   * @default 0
   */
  finalBakeTimeInMinutes?: Duration.Input;
  /**
   * Where to save a copy of the applied configuration. Immutable — changing
   * it replaces the strategy.
   * @default "NONE"
   */
  replicateTo?: "NONE" | "SSM_DOCUMENT";
  /**
   * Description of the deployment strategy.
   */
  description?: string;
  /**
   * User-defined tags for the deployment strategy.
   */
  tags?: Record<string, string>;
}

export interface DeploymentStrategy extends Resource<
  "AWS.AppConfig.DeploymentStrategy",
  DeploymentStrategyProps,
  {
    deploymentStrategyId: string;
    deploymentStrategyName: string;
    deploymentStrategyArn: string;
  },
  never,
  Providers
> {}

/**
 * An AWS AppConfig deployment strategy — defines how a configuration version
 * rolls out to an environment: the total duration, the per-interval growth,
 * and the final bake time during which alarms can trigger a rollback.
 *
 * @resource
 * @section Creating a Deployment Strategy
 * @example All-At-Once (instant, no bake)
 * ```typescript
 * const strategy = yield* AppConfig.DeploymentStrategy("Fast", {
 *   deploymentDurationInMinutes: 0,
 *   growthFactor: 100,
 *   finalBakeTimeInMinutes: 0,
 *   replicateTo: "NONE",
 * });
 * ```
 *
 * @example Linear rollout over 10 minutes
 * ```typescript
 * const strategy = yield* AppConfig.DeploymentStrategy("Linear", {
 *   deploymentDurationInMinutes: "10 minutes",
 *   growthFactor: 25,
 *   growthType: "LINEAR",
 *   finalBakeTimeInMinutes: "5 minutes",
 * });
 * ```
 */
export const DeploymentStrategy = Resource<DeploymentStrategy>(
  "AWS.AppConfig.DeploymentStrategy",
);

/**
 * Normalize a `Duration.Input` that may have round-tripped through state
 * JSON (which flattens a `Duration` to its `toJSON` shape
 * `{_id:"Duration",_tag:"Millis"|"Nanos"|"Infinity",...}`, not a valid
 * `Duration.Input`) back into an input `Duration.toMinutes` accepts.
 */
const normalizeDurationInput = (input: Duration.Input): Duration.Input => {
  const json = input as {
    _id?: unknown;
    _tag?: "Millis" | "Nanos" | "Infinity" | "NegativeInfinity";
    millis?: number;
    nanos?: string;
  };
  return json._id === "Duration"
    ? json._tag === "Millis"
      ? json.millis!
      : json._tag === "Nanos"
        ? BigInt(json.nanos!)
        : "Infinity"
    : input;
};

/** Convert an optional duration input to whole wire minutes. */
function toWireMinutes(input: Duration.Input): number;
function toWireMinutes(input: Duration.Input | undefined): number | undefined;
function toWireMinutes(input: Duration.Input | undefined): number | undefined {
  return input === undefined
    ? undefined
    : Math.round(Duration.toMinutes(normalizeDurationInput(input)));
}

export const DeploymentStrategyProvider = () =>
  Provider.effect(
    DeploymentStrategy,
    Effect.gen(function* () {
      const toName = (id: string, props: Partial<DeploymentStrategyProps>) =>
        props.deploymentStrategyName
          ? Effect.succeed(props.deploymentStrategyName)
          : createPhysicalName({ id, maxLength: 64 });

      const readStrategy = Effect.fn(function* (deploymentStrategyId: string) {
        return yield* appconfig
          .getDeploymentStrategy({ DeploymentStrategyId: deploymentStrategyId })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      const findByName = Effect.fn(function* (name: string) {
        const strategies = yield* appconfig.listDeploymentStrategies
          .pages({})
          .pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) => page.Items ?? []),
            ),
          );
        return strategies.find((s) => s.Name === name);
      });

      return {
        stables: [
          "deploymentStrategyId",
          "deploymentStrategyName",
          "deploymentStrategyArn",
        ],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            (yield* toName(id, olds ?? {})) !== (yield* toName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
          // ReplicateTo is create-only.
          if ((olds?.replicateTo ?? "NONE") !== (news?.replicateTo ?? "NONE")) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const strategy = output?.deploymentStrategyId
            ? yield* readStrategy(output.deploymentStrategyId)
            : yield* findByName(yield* toName(id, olds ?? {}));
          if (strategy?.Id === undefined) return undefined;
          const arn = deploymentStrategyArn(region, accountId, strategy.Id);
          const attrs = {
            deploymentStrategyId: strategy.Id,
            deploymentStrategyName: strategy.Name!,
            deploymentStrategyArn: arn,
          };
          const tags = yield* readAppConfigTags(arn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const name =
            output?.deploymentStrategyName ?? (yield* toName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // 1. Observe.
          let observed = output?.deploymentStrategyId
            ? yield* readStrategy(output.deploymentStrategyId)
            : undefined;
          if (observed === undefined) {
            observed = yield* findByName(name);
          }

          // 2. Ensure.
          if (observed?.Id === undefined) {
            observed = yield* appconfig.createDeploymentStrategy({
              Name: name,
              Description: news.description,
              DeploymentDurationInMinutes: toWireMinutes(
                news.deploymentDurationInMinutes,
              ),
              FinalBakeTimeInMinutes: toWireMinutes(
                news.finalBakeTimeInMinutes,
              ),
              GrowthFactor: news.growthFactor,
              GrowthType: news.growthType,
              ReplicateTo: news.replicateTo ?? "NONE",
              Tags: desiredTags,
            });
          } else {
            // 3. Sync — everything but Name and ReplicateTo is mutable.
            observed = yield* appconfig.updateDeploymentStrategy({
              DeploymentStrategyId: observed.Id,
              Description: news.description,
              DeploymentDurationInMinutes: toWireMinutes(
                news.deploymentDurationInMinutes,
              ),
              FinalBakeTimeInMinutes: toWireMinutes(
                news.finalBakeTimeInMinutes,
              ),
              GrowthFactor: news.growthFactor,
              GrowthType: news.growthType,
            });
          }

          const arn = deploymentStrategyArn(region, accountId, observed.Id!);

          // 3b. Sync tags.
          yield* syncAppConfigTags(arn, desiredTags);

          yield* session.note(name);
          return {
            deploymentStrategyId: observed.Id!,
            deploymentStrategyName: observed.Name ?? name,
            deploymentStrategyArn: arn,
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* appconfig
            .deleteDeploymentStrategy({
              DeploymentStrategyId: output.deploymentStrategyId,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),

        list: () =>
          Effect.gen(function* () {
            const { accountId, region } = yield* AWSEnvironment.current;
            const strategies = yield* appconfig.listDeploymentStrategies
              .pages({})
              .pipe(
                Stream.runCollect,
                Effect.map((chunk) =>
                  Array.from(chunk).flatMap((page) => page.Items ?? []),
                ),
              );
            return strategies.flatMap((s) =>
              s.Id !== undefined && s.Name !== undefined
                ? [
                    {
                      deploymentStrategyId: s.Id,
                      deploymentStrategyName: s.Name,
                      deploymentStrategyArn: deploymentStrategyArn(
                        region,
                        accountId,
                        s.Id,
                      ),
                    },
                  ]
                : [],
            );
          }),
      };
    }),
  );
