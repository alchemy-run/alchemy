import type * as rest from "@distilled.cloud/stackit/workflows_airflow";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { AirflowClient } from "./AirflowClient.ts";
import type { Instance } from "./Instance.ts";

export interface ListTaskInstancesRequest extends rest.ListTaskInstancesRequest {}

/**
 * Runtime binding for Airflow's `GET /api/v2/dags/{dag_id}/dagRuns/{dag_run_id}/taskInstances`:
 * read the state of each task in a run. A page holds 50 by default: page with `limit` and `offset`
 * up to `total_entries`.
 *
 * Bind this operation to an {@link Instance} and an `AirflowClient` in a Function/Worker init
 * phase and provide {@link ListTaskInstancesHttp}.
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
 * ### Reading a Run's Tasks
 * **Example:** Report which tasks failed from a Cloudflare Worker
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
 *     const listTaskInstances = yield* Stackit.Workflows.ListTaskInstances(airflow, {
 *       discoveryEndpoint: "https://login.example.com/realms/acme/.well-known/openid-configuration",
 *       clientId: "reports-api",
 *       clientSecret: yield* Config.redacted("AIRFLOW_CLIENT_SECRET"),
 *     });
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const request = yield* HttpServerRequest;
 *         const runId = new URL(request.url, "http://worker").searchParams.get("run") ?? "";
 *         const { task_instances } = yield* listTaskInstances({
 *           dag_id: "reports",
 *           dag_run_id: runId,
 *           state: ["failed"],
 *         });
 *         return yield* HttpServerResponse.json(task_instances.map((task) => task.task_id));
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Workflows.ListTaskInstancesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Workflows
 */
export interface ListTaskInstances extends Binding.Service<
  ListTaskInstances,
  "Stackit.Workflows.ListTaskInstances",
  (
    instance: Instance,
    client: AirflowClient,
  ) => Effect.Effect<
    (
      request: ListTaskInstancesRequest,
    ) => Effect.Effect<
      rest.TaskInstanceCollectionResponse,
      rest.ListTaskInstancesError,
      RuntimeContext
    >
  >
> {}

export const ListTaskInstances = Binding.Service<ListTaskInstances>(
  "Stackit.Workflows.ListTaskInstances",
);
