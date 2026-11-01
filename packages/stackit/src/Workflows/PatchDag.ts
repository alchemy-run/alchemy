import type * as rest from "@distilled.cloud/stackit/workflows_airflow";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { AirflowClient } from "./AirflowClient.ts";
import type { Instance } from "./Instance.ts";

export interface PatchDagRequest extends rest.PatchDagRequest {}

/**
 * Runtime binding for Airflow's `PATCH /api/v2/dags/{dag_id}`: pause or unpause a DAG, the one
 * thing Airflow's REST API lets you change on it. New DAGs start paused, unless your Airflow says
 * otherwise.
 *
 * Bind this operation to an {@link Instance} and an `AirflowClient` in a Function/Worker init
 * phase and provide {@link PatchDagHttp}.
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
 * ### Pausing a DAG
 * **Example:** Unpause a DAG from a Cloudflare Worker
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
 *     const patchDag = yield* Stackit.Workflows.PatchDag(airflow, {
 *       discoveryEndpoint: "https://login.example.com/realms/acme/.well-known/openid-configuration",
 *       clientId: "reports-api",
 *       clientSecret: yield* Config.redacted("AIRFLOW_CLIENT_SECRET"),
 *     });
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const dag = yield* patchDag({ dag_id: "reports", is_paused: false });
 *         return yield* HttpServerResponse.json({ paused: dag.is_paused });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Workflows.PatchDagHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Workflows
 */
export interface PatchDag extends Binding.Service<
  PatchDag,
  "Stackit.Workflows.PatchDag",
  (
    instance: Instance,
    client: AirflowClient,
  ) => Effect.Effect<
    (
      request: PatchDagRequest,
    ) => Effect.Effect<rest.DAGResponse, rest.PatchDagError, RuntimeContext>
  >
> {}

export const PatchDag = Binding.Service<PatchDag>("Stackit.Workflows.PatchDag");
