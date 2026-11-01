import type * as rest from "@distilled.cloud/stackit/workflows_airflow";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { AirflowClient } from "./AirflowClient.ts";
import type { Instance } from "./Instance.ts";

export interface GetDagRequest extends rest.GetDagRequest {}

/**
 * Runtime binding for Airflow's `GET /api/v2/dags/{dag_id}`: read a DAG, such as whether it is
 * paused and whether its file failed to import. A DAG only exists once Airflow has parsed its
 * file, so a new one answers `NotFound` for a while.
 *
 * Bind this operation to an {@link Instance} and an `AirflowClient` in a Function/Worker init
 * phase and provide {@link GetDagHttp}.
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
 * ### Reading a DAG
 * **Example:** Report a DAG's state from a Cloudflare Worker
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
 *     const getDag = yield* Stackit.Workflows.GetDag(airflow, {
 *       discoveryEndpoint: "https://login.example.com/realms/acme/.well-known/openid-configuration",
 *       clientId: "reports-api",
 *       clientSecret: yield* Config.redacted("AIRFLOW_CLIENT_SECRET"),
 *     });
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const dag = yield* getDag({ dag_id: "reports" });
 *         return yield* HttpServerResponse.json({ paused: dag.is_paused, importErrors: dag.has_import_errors });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Workflows.GetDagHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Workflows
 */
export interface GetDag extends Binding.Service<
  GetDag,
  "Stackit.Workflows.GetDag",
  (
    instance: Instance,
    client: AirflowClient,
  ) => Effect.Effect<
    (request: GetDagRequest) => Effect.Effect<rest.DAGResponse, rest.GetDagError, RuntimeContext>
  >
> {}

export const GetDag = Binding.Service<GetDag>("Stackit.Workflows.GetDag");
