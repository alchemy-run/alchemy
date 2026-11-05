import * as forecast from "@distilled.cloud/aws/forecast";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeForecastHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `forecast:CreateWhatIfForecast` — create a scenario
 * forecast under a what-if analysis, transforming the baseline time series
 * (or replacing it from S3) so the outcome can be compared with
 * {@link QueryWhatIfForecast}.
 *
 * What-if forecast ARNs are created at runtime, so the binding takes no
 * arguments and grants `forecast:CreateWhatIfForecast` on `*`, plus
 * `iam:PassRole` (conditioned to `forecast.amazonaws.com`) for the
 * replacement-data-source role. Provide the implementation with
 * `Effect.provide(AWS.Forecast.CreateWhatIfForecastHttp)`.
 *
 * ### What-If Scenarios
 * **Example:** Create a Price-Drop Scenario
 * ```typescript
 * // init
 * const createWhatIfForecast = yield* AWS.Forecast.CreateWhatIfForecast();
 *
 * // runtime
 * const scenario = yield* createWhatIfForecast({
 *   WhatIfForecastName: "price_drop_10pct",
 *   WhatIfAnalysisArn: analysisArn,
 *   TimeSeriesTransformations: [
 *     {
 *       Action: {
 *         AttributeName: "price",
 *         Operation: "MULTIPLY",
 *         Value: 0.9,
 *       },
 *     },
 *   ],
 * });
 * ```
 *
 * @binding
 */
export interface CreateWhatIfForecast extends Binding.Service<
  CreateWhatIfForecast,
  "AWS.Forecast.CreateWhatIfForecast",
  () => Effect.Effect<
    (
      request: forecast.CreateWhatIfForecastRequest,
    ) => Effect.Effect<forecast.CreateWhatIfForecastResponse, forecast.CreateWhatIfForecastError>
  >
> {}
export const CreateWhatIfForecast = Binding.Service<CreateWhatIfForecast>(
  "AWS.Forecast.CreateWhatIfForecast",
);

export const CreateWhatIfForecastHttp = Layer.effect(
  CreateWhatIfForecast,
  makeForecastHttpBinding({
    capability: "CreateWhatIfForecast",
    iamActions: ["forecast:CreateWhatIfForecast"],
    operation: forecast.createWhatIfForecast,
    // TimeSeriesReplacementsDataSource hands Forecast a role to read S3.
    passRole: true,
  }),
);
