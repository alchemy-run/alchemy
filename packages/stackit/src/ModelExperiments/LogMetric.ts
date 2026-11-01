import type * as mlflow from "@distilled.cloud/stackit/model_experiments_mlflow";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Token } from "./Token.ts";

export type LogMetricRequest = mlflow.LogMetricRequest;

/**
 * Runtime binding for MLflow's `runs/log-metric`: log one value of a metric. A metric keeps a
 * history, so log the same key again at each step. A missing run fails with `NotFound`. Bind
 * it to a {@link Token} and provide {@link LogMetricHttp}. Field names are MLflow's own.
 *
 * Access: the bound tracking token, which reaches its one instance. Nothing else is granted,
 * and no service account is created. The token's value reaches the host's env `Redacted`.
 *
 * ### Logging a Metric
 * **Example:** Log a loss value
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Clock from "effect/Clock";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Experiments = Stackit.ModelExperiments.Instance("Experiments", {});
 * export const Tracking = Experiments.pipe(
 *   Effect.flatMap((instance) =>
 *     Stackit.ModelExperiments.Token("Tracking", { instanceId: instance.instanceId }),
 *   ),
 * );
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const binding = yield* Stackit.ModelExperiments.LogMetric(yield* Tracking);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const timestamp = yield* Clock.currentTimeMillis;
 *         yield* binding({ run_id: "abc", key: "loss", value: 0.5, timestamp, step: 1 });
 *         return HttpServerResponse.empty();
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ModelExperiments.LogMetricHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT AI Model Experiments
 * @category ModelExperiments
 */
export interface LogMetric extends Binding.Service<
  LogMetric,
  "Stackit.ModelExperiments.LogMetric",
  (
    token: Token,
  ) => Effect.Effect<
    (
      request: LogMetricRequest,
    ) => Effect.Effect<mlflow.LogMetricResponse2, mlflow.LogMetricError, RuntimeContext>
  >
> {}

export const LogMetric = Binding.Service<LogMetric>("Stackit.ModelExperiments.LogMetric");
