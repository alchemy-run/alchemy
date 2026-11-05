import * as deadline from "@distilled.cloud/aws/deadline";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeDeadlineFarmHttpBinding } from "./BindingHttp.ts";
import type { Farm } from "./Farm.ts";

/**
 * Runtime binding for `deadline:GetSessionsStatisticsAggregation`.
 *
 * Fetches the status and results (cost in USD, runtime, per-group stats)
 * of an aggregation started with
 * {@link StartSessionsStatisticsAggregation} on the bound {@link Farm}.
 * The farm's `farmId` is injected from the binding. Provide the
 * implementation with
 * `Effect.provide(AWS.Deadline.GetSessionsStatisticsAggregationHttp)`.
 * ### Usage Statistics
 * **Example:** Poll An Aggregation Until It Completes
 * ```typescript
 * // init — bind the operation to the farm
 * const getAggregation =
 *   yield* AWS.Deadline.GetSessionsStatisticsAggregation(farm);
 *
 * // runtime
 * const result = yield* getAggregation({ aggregationId }).pipe(
 *   Effect.repeat({
 *     schedule: Schedule.spaced("2 seconds"),
 *     until: (r) => r.status !== "IN_PROGRESS",
 *     times: 30,
 *   }),
 * );
 * ```
 *
 * @binding
 */
export interface GetSessionsStatisticsAggregation extends Binding.Service<
  GetSessionsStatisticsAggregation,
  "AWS.Deadline.GetSessionsStatisticsAggregation",
  (
    farm: Farm,
  ) => Effect.Effect<
    (
      request: Omit<deadline.GetSessionsStatisticsAggregationRequest, "farmId">,
    ) => Effect.Effect<
      deadline.GetSessionsStatisticsAggregationResponse,
      deadline.GetSessionsStatisticsAggregationError
    >
  >
> {}
export const GetSessionsStatisticsAggregation = Binding.Service<GetSessionsStatisticsAggregation>(
  "AWS.Deadline.GetSessionsStatisticsAggregation",
);

export const GetSessionsStatisticsAggregationHttp = Layer.effect(
  GetSessionsStatisticsAggregation,
  makeDeadlineFarmHttpBinding({
    tag: "AWS.Deadline.GetSessionsStatisticsAggregation",
    operation: deadline.getSessionsStatisticsAggregation,
    actions: ["deadline:GetSessionsStatisticsAggregation"],
  }),
);
