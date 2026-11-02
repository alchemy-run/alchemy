import type * as mlflow from "@distilled.cloud/stackit/model_experiments_mlflow";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Token } from "./Token.ts";

export type UpdateRunRequest = mlflow.UpdateRunRequest;

/**
 * Runtime binding for MLflow's `runs/update`: change a run's status, end time or name, as when
 * it finishes. A missing run fails with `NotFound`. Bind it to a {@link Token} and provide
 * {@link UpdateRunHttp}. Field names are MLflow's own.
 *
 * Access: the bound tracking token, which reaches its one instance. Nothing else is granted,
 * and no service account is created. The token's value reaches the host's env `Redacted`.
 *
 * ### Finishing a Run
 * **Example:** Mark a run finished
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
 *     const binding = yield* Stackit.ModelExperiments.UpdateRun(yield* Tracking);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const end_time = yield* Clock.currentTimeMillis;
 *         const { run_info } = yield* binding({ run_id: "abc", status: "FINISHED", end_time });
 *         return yield* HttpServerResponse.json({ status: run_info.status });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ModelExperiments.UpdateRunHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT AI Model Experiments
 * @category ModelExperiments
 */
export interface UpdateRun extends Binding.Service<
  UpdateRun,
  "Stackit.ModelExperiments.UpdateRun",
  (
    token: Token,
  ) => Effect.Effect<
    (
      request: UpdateRunRequest,
    ) => Effect.Effect<mlflow.UpdateRunResponse, mlflow.UpdateRunError, RuntimeContext>
  >
> {}

export const UpdateRun = Binding.Service<UpdateRun>("Stackit.ModelExperiments.UpdateRun");
