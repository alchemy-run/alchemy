import type * as rest from "@distilled.cloud/stackit/workflows_airflow";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { AirflowClient } from "./AirflowClient.ts";
import type { Instance } from "./Instance.ts";

export interface GetDagRunRequest extends rest.GetDagRunRequest {}

/**
 * Runtime binding for Airflow's `GET /api/v2/dags/{dag_id}/dagRuns/{dag_run_id}`: read a DAG run's
 * state. `success` and `failed` are final; `queued` and `running` mean it is still going.
 *
 * Bind this operation to an {@link Instance} and an `AirflowClient` in a Function/Worker init
 * phase and provide {@link GetDagRunHttp}.
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
 * ### Reading a Run
 * **Example:** Report a run's state from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 * import * as Effect from "effect/Effect";
 * import { HttpServerRequest } from "effect/http/HttpServerRequest";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Airflow = Stackit.Workflows.Instance("Airflow", {});
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const airflow = yield* Airflow;
 *     const getDagRun = yield* Stackit.Workflows.GetDagRun(airflow, {
 *       discoveryEndpoint: "https://login.example.com/realms/acme/.well-known/openid-configuration",
 *       clientId: "reports-api",
 *       clientSecret: yield* Config.redacted("AIRFLOW_CLIENT_SECRET"),
 *     });
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const request = yield* HttpServerRequest;
 *         const runId = new URL(request.url, "http://worker").searchParams.get("run") ?? "";
 *         const run = yield* getDagRun({ dag_id: "reports", dag_run_id: runId });
 *         return yield* HttpServerResponse.json({ state: run.state });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Workflows.GetDagRunHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Workflows
 */
export interface GetDagRun extends Binding.Service<
  GetDagRun,
  "Stackit.Workflows.GetDagRun",
  (
    instance: Instance,
    client: AirflowClient,
  ) => Effect.Effect<
    (
      request: GetDagRunRequest,
    ) => Effect.Effect<rest.DAGRunResponse, rest.GetDagRunError, RuntimeContext>
  >
> {}

export const GetDagRun = Binding.Service<GetDagRun>("Stackit.Workflows.GetDagRun");
