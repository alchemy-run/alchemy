import * as xray from "@distilled.cloud/aws/xray";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeXRayHttpBinding } from "./BindingHttp.ts";

export interface GetTimeSeriesServiceStatisticsRequest
  extends xray.GetTimeSeriesServiceStatisticsRequest {}

/**
 * Retrieve an aggregation of service statistics (response-time and error
 * histograms) as a time series over a window, optionally filtered by
 * group or entity selector expression.
 *
 * Bind the operation in the function's init phase to get a runtime callable;
 * provide the implementation with `Effect.provide(XRay.GetTimeSeriesServiceStatisticsHttp)`.
 * The action is account-scoped: X-Ray does not support resource-level
 * permissions for `xray:GetTimeSeriesServiceStatistics`, so the binding grants it on `*`.
 * ### Service Graphs & Statistics
 * **Example:** Time-series statistics for one service
 * ```typescript
 * import * as XRay from "@alchemy.run/aws/XRay";
 *
 * // init — grants xray:GetTimeSeriesServiceStatistics
 * const getTimeSeriesServiceStatistics =
 *   yield* XRay.GetTimeSeriesServiceStatistics();
 *
 * // runtime
 * const now = yield* Effect.sync(() => Date.now());
 * const stats = yield* getTimeSeriesServiceStatistics({
 *   StartTime: new Date(now - 10 * 60 * 1000),
 *   EndTime: new Date(now),
 *   EntitySelectorExpression: 'service("my-api")',
 *   Period: 60,
 * });
 * const points = stats.TimeSeriesServiceStatistics ?? [];
 * ```
 *
 * @binding
 */
export interface GetTimeSeriesServiceStatistics extends Binding.Service<
  GetTimeSeriesServiceStatistics,
  "AWS.XRay.GetTimeSeriesServiceStatistics",
  () => Effect.Effect<
    (
      request: GetTimeSeriesServiceStatisticsRequest,
    ) => Effect.Effect<
      xray.GetTimeSeriesServiceStatisticsResult,
      xray.GetTimeSeriesServiceStatisticsError
    >
  >
> {}
export const GetTimeSeriesServiceStatistics = Binding.Service<GetTimeSeriesServiceStatistics>(
  "AWS.XRay.GetTimeSeriesServiceStatistics",
);

/**
 * HTTP implementation of the `XRay.GetTimeSeriesServiceStatistics` binding.
 *
 * At deploy time it grants `xray:GetTimeSeriesServiceStatistics` on `*` to the host Lambda
 * Function (the action does not support resource-level permissions); at
 * runtime it calls the X-Ray API with the function's execution role
 * credentials.
 *
 * @example Provide on the Function effect
 * ```typescript
 * import * as XRay from "@alchemy.run/aws/XRay";
 *
 * Effect.gen(function* () {
 *   const getTimeSeriesServiceStatistics = yield* XRay.GetTimeSeriesServiceStatistics();
 *   // ...
 * }).pipe(Effect.provide(XRay.GetTimeSeriesServiceStatisticsHttp));
 * ```
 */
export const GetTimeSeriesServiceStatisticsHttp = Layer.effect(
  GetTimeSeriesServiceStatistics,
  makeXRayHttpBinding({
    tag: "AWS.XRay.GetTimeSeriesServiceStatistics",
    operation: xray.getTimeSeriesServiceStatistics,
    actions: ["xray:GetTimeSeriesServiceStatistics"],
  }),
);
