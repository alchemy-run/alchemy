import type * as rest from "@distilled.cloud/stackit/workflows_airflow";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { AirflowClient } from "./AirflowClient.ts";
import type { Instance } from "./Instance.ts";

export interface TriggerDagRunRequest extends Omit<rest.TriggerDagRunRequest, "logical_date"> {
  /**
   * The run's logical date. Airflow needs the field, and `null` lets it pick one.
   *
   * @default null
   */
  logical_date?: string | null;
}

/**
 * Runtime binding for Airflow's `POST /api/v2/dags/{dag_id}/dagRuns`: start a DAG run. Pass
 * `dag_run_id` to make it idempotent: a second run with that id fails with `Conflict`. A paused
 * DAG takes the run but doesn't start it, so unpause it with `PatchDag`.
 *
 * Bind this operation to an {@link Instance} and an `AirflowClient` in a Function/Worker init
 * phase and provide {@link TriggerDagRunHttp}.
 *
 * Calls sign in as an OAuth2 client of the instance's identity provider, so this grants no STACKIT
 * role and creates no service account: it exchanges the client's token for a session at the
 * instance, as STACKIT's docs describe. The instance's identity provider has to be `oauth2` with
 * `apiAudience` set, the client's token has to carry that audience, and the provider's roles claim
 * decides what Airflow lets the client do: `User` can trigger, `Viewer` only read.
 *
 * It calls Airflow's own REST API (`/api/v2`) at the instance's `url`, which needs Airflow 3. On
 * an Airflow 2 instance each call fails with `ConfigError`.
 *
 * ### Starting a Run
 * **Example:** Start a run from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Airflow = Stackit.Workflows.Instance("Airflow", {});
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const airflow = yield* Airflow;
 *     const trigger = yield* Stackit.Workflows.TriggerDagRun(airflow, {
 *       discoveryEndpoint: "https://login.example.com/realms/acme/.well-known/openid-configuration",
 *       clientId: "reports-api",
 *       clientSecret: yield* Config.Redacted("AIRFLOW_CLIENT_SECRET"),
 *     });
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const run = yield* trigger({ dag_id: "reports", conf: { day: "2026-11-01" } });
 *         return yield* HttpServerResponse.json({ runId: run.dag_run_id, state: run.state });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Workflows.TriggerDagRunHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Workflows
 */
export interface TriggerDagRun extends Binding.Service<
  TriggerDagRun,
  "Stackit.Workflows.TriggerDagRun",
  (
    instance: Instance,
    client: AirflowClient,
  ) => Effect.Effect<
    (
      request: TriggerDagRunRequest,
    ) => Effect.Effect<rest.DAGRunResponse, rest.TriggerDagRunError, RuntimeContext>
  >
> {}

export const TriggerDagRun = Binding.Service<TriggerDagRun>("Stackit.Workflows.TriggerDagRun");
