import type * as mlflow from "@distilled.cloud/stackit/model_experiments_mlflow";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Token } from "./Token.ts";

export type CreateRunRequest = mlflow.CreateRunRequest;

/**
 * Runtime binding for MLflow's `runs/create`: start a run in an experiment. A missing
 * experiment fails with `NotFound`. Bind it to a {@link Token} and provide {@link
 * CreateRunHttp}. Field names are MLflow's own.
 *
 * Access: the bound tracking token, which reaches its one instance. Nothing else is granted,
 * and no service account is created. The token's value reaches the host's env `Redacted`.
 *
 * ### Starting a Run
 * **Example:** Start a run
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
 *     const binding = yield* Stackit.ModelExperiments.CreateRun(yield* Tracking);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { run } = yield* binding({ experiment_id: "123", run_name: "nightly" });
 *         return yield* HttpServerResponse.json({ id: run.info.run_id });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ModelExperiments.CreateRunHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT AI Model Experiments
 * @category ModelExperiments
 */
export interface CreateRun extends Binding.Service<
  CreateRun,
  "Stackit.ModelExperiments.CreateRun",
  (
    token: Token,
  ) => Effect.Effect<
    (
      request: CreateRunRequest,
    ) => Effect.Effect<mlflow.GetRunResponse, mlflow.CreateRunError, RuntimeContext>
  >
> {}

export const CreateRun = Binding.Service<CreateRun>("Stackit.ModelExperiments.CreateRun");
