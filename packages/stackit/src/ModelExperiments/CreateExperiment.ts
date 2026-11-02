import type * as mlflow from "@distilled.cloud/stackit/model_experiments_mlflow";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Token } from "./Token.ts";

export type CreateExperimentRequest = mlflow.CreateExperimentRequest;

/**
 * Runtime binding for MLflow's `experiments/create`: create an experiment. A taken name fails
 * with `ExperimentAlreadyExists`. Bind it to a {@link Token} and provide {@link
 * CreateExperimentHttp}. Field names are MLflow's own.
 *
 * Access: the bound tracking token, which reaches its one instance. Nothing else is granted,
 * and no service account is created. The token's value reaches the host's env `Redacted`.
 *
 * ### Creating an Experiment
 * **Example:** Create an experiment, or read the one with that name
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
 *     const binding = yield* Stackit.ModelExperiments.CreateExperiment(yield* Tracking);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { experiment_id } = yield* binding({ name: "training" });
 *         return yield* HttpServerResponse.json({ experiment_id });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ModelExperiments.CreateExperimentHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT AI Model Experiments
 * @category ModelExperiments
 */
export interface CreateExperiment extends Binding.Service<
  CreateExperiment,
  "Stackit.ModelExperiments.CreateExperiment",
  (
    token: Token,
  ) => Effect.Effect<
    (
      request: CreateExperimentRequest,
    ) => Effect.Effect<
      mlflow.CreateExperimentResponse,
      mlflow.CreateExperimentError,
      RuntimeContext
    >
  >
> {}

export const CreateExperiment = Binding.Service<CreateExperiment>(
  "Stackit.ModelExperiments.CreateExperiment",
);
