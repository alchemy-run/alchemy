import type * as mlflow from "@distilled.cloud/stackit/model_experiments_mlflow";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Token } from "./Token.ts";

export type SearchRunsRequest = mlflow.SearchRunsRequest;

/**
 * Runtime binding for MLflow's `runs/search`: find runs in experiments, with MLflow's filter
 * syntax. It returns one page; pass `next_page_token` back as `page_token` for the next. Bind
 * it to a {@link Token} and provide {@link SearchRunsHttp}. Field names are MLflow's own.
 *
 * Access: the bound tracking token, which reaches its one instance. Nothing else is granted,
 * and no service account is created. The token's value reaches the host's env `Redacted`.
 *
 * ### Searching Runs
 * **Example:** Find the best runs
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
 *     const binding = yield* Stackit.ModelExperiments.SearchRuns(yield* Tracking);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { runs } = yield* binding({
 *           experiment_ids: ["123"],
 *           filter: "metrics.loss < 1",
 *           order_by: ["metrics.loss ASC"],
 *           max_results: 10,
 *         });
 *         return yield* HttpServerResponse.json((runs ?? []).map((run) => run.info.run_id));
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ModelExperiments.SearchRunsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT AI Model Experiments
 * @category ModelExperiments
 */
export interface SearchRuns extends Binding.Service<
  SearchRuns,
  "Stackit.ModelExperiments.SearchRuns",
  (
    token: Token,
  ) => Effect.Effect<
    (
      request: SearchRunsRequest,
    ) => Effect.Effect<mlflow.SearchRunsResponse, mlflow.SearchRunsError, RuntimeContext>
  >
> {}

export const SearchRuns = Binding.Service<SearchRuns>("Stackit.ModelExperiments.SearchRuns");
