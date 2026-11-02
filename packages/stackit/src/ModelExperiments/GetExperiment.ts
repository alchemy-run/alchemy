import type * as mlflow from "@distilled.cloud/stackit/model_experiments_mlflow";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Token } from "./Token.ts";

export type GetExperimentRequest = mlflow.GetExperimentRequest;

/**
 * Runtime binding for MLflow's `experiments/get`: read an experiment by its id. A missing one
 * fails with `NotFound`. Bind it to a {@link Token} and provide {@link GetExperimentHttp}.
 * Field names are MLflow's own.
 *
 * Access: the bound tracking token, which reaches its one instance. Nothing else is granted,
 * and no service account is created. The token's value reaches the host's env `Redacted`.
 *
 * ### Reading an Experiment
 * **Example:** Read an experiment
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
 *     const binding = yield* Stackit.ModelExperiments.GetExperiment(yield* Tracking);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { experiment } = yield* binding({ experiment_id: "123" });
 *         return yield* HttpServerResponse.json({ name: experiment.name });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ModelExperiments.GetExperimentHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT AI Model Experiments
 * @category ModelExperiments
 */
export interface GetExperiment extends Binding.Service<
  GetExperiment,
  "Stackit.ModelExperiments.GetExperiment",
  (
    token: Token,
  ) => Effect.Effect<
    (
      request: GetExperimentRequest,
    ) => Effect.Effect<mlflow.GetExperimentResponse, mlflow.GetExperimentError, RuntimeContext>
  >
> {}

export const GetExperiment = Binding.Service<GetExperiment>(
  "Stackit.ModelExperiments.GetExperiment",
);
