import type * as mlflow from "@distilled.cloud/stackit/model_experiments_mlflow";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Token } from "./Token.ts";

export type LogParamRequest = mlflow.LogParamRequest;

/**
 * Runtime binding for MLflow's `runs/log-parameter`: log a parameter of a run. Logging a key
 * again with the same value does nothing; another value fails with `ParamValueConflict`. Bind
 * it to a {@link Token} and provide {@link LogParamHttp}. Field names are MLflow's own.
 *
 * Access: the bound tracking token, which reaches its one instance. Nothing else is granted,
 * and no service account is created. The token's value reaches the host's env `Redacted`.
 *
 * ### Logging a Parameter
 * **Example:** Log a learning rate
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
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
 *     const binding = yield* Stackit.ModelExperiments.LogParam(yield* Tracking);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* binding({ run_id: "abc", key: "lr", value: "0.1" });
 *         return HttpServerResponse.empty();
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ModelExperiments.LogParamHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT AI Model Experiments
 * @category ModelExperiments
 */
export interface LogParam extends Binding.Service<
  LogParam,
  "Stackit.ModelExperiments.LogParam",
  (
    token: Token,
  ) => Effect.Effect<
    (
      request: LogParamRequest,
    ) => Effect.Effect<mlflow.LogParamResponse2, mlflow.LogParamError, RuntimeContext>
  >
> {}

export const LogParam = Binding.Service<LogParam>("Stackit.ModelExperiments.LogParam");
