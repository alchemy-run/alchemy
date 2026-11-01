import type * as mlflow from "@distilled.cloud/stackit/model_experiments_mlflow";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Token } from "./Token.ts";

export type GetRunRequest = mlflow.GetRunRequest;

/**
 * Runtime binding for MLflow's `runs/get`: read a run with its latest metrics, params and
 * tags. A missing run fails with `NotFound`. Bind it to a {@link Token} and provide {@link
 * GetRunHttp}. Field names are MLflow's own.
 *
 * Access: the bound tracking token, which reaches its one instance. Nothing else is granted,
 * and no service account is created. The token's value reaches the host's env `Redacted`.
 *
 * ### Reading a Run
 * **Example:** Read a run's metrics
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
 *     const binding = yield* Stackit.ModelExperiments.GetRun(yield* Tracking);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { run } = yield* binding({ run_id: "abc" });
 *         return yield* HttpServerResponse.json({ metrics: run.data?.metrics ?? [] });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ModelExperiments.GetRunHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT AI Model Experiments
 * @category ModelExperiments
 */
export interface GetRun extends Binding.Service<
  GetRun,
  "Stackit.ModelExperiments.GetRun",
  (
    token: Token,
  ) => Effect.Effect<
    (
      request: GetRunRequest,
    ) => Effect.Effect<mlflow.GetRunResponse, mlflow.GetRunError, RuntimeContext>
  >
> {}

export const GetRun = Binding.Service<GetRun>("Stackit.ModelExperiments.GetRun");
