import type * as mlflow from "@distilled.cloud/stackit/model_experiments_mlflow";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Token } from "./Token.ts";

export type GetExperimentByNameRequest = mlflow.GetExperimentByNameRequest;

/**
 * Runtime binding for MLflow's `experiments/get-by-name`: read an experiment by its name, as
 * after `ExperimentAlreadyExists`. A missing one fails with `NotFound`. Bind it to a {@link
 * Token} and provide {@link GetExperimentByNameHttp}. Field names are MLflow's own.
 *
 * Access: the bound tracking token, which reaches its one instance. Nothing else is granted,
 * and no service account is created. The token's value reaches the host's env `Redacted`.
 *
 * ### Reading an Experiment
 * **Example:** Find an experiment by name
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
 *     const binding = yield* Stackit.ModelExperiments.GetExperimentByName(yield* Tracking);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { experiment } = yield* binding({ experiment_name: "training" });
 *         return yield* HttpServerResponse.json({ id: experiment.experiment_id });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ModelExperiments.GetExperimentByNameHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT AI Model Experiments
 * @category ModelExperiments
 */
export interface GetExperimentByName extends Binding.Service<
  GetExperimentByName,
  "Stackit.ModelExperiments.GetExperimentByName",
  (
    token: Token,
  ) => Effect.Effect<
    (
      request: GetExperimentByNameRequest,
    ) => Effect.Effect<
      mlflow.GetExperimentResponse,
      mlflow.GetExperimentByNameError,
      RuntimeContext
    >
  >
> {}

export const GetExperimentByName = Binding.Service<GetExperimentByName>(
  "Stackit.ModelExperiments.GetExperimentByName",
);
