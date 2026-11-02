import type * as rest from "@distilled.cloud/stackit/workflows_airflow";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { AirflowClient } from "./AirflowClient.ts";
import type { Instance } from "./Instance.ts";

export interface SetConnectionRequest extends rest.CreateConnectionRequest {}

/**
 * Runtime binding for Airflow's `/api/v2/connections`: set a connection that DAGs read, creating
 * it if it doesn't exist. A field left out of an update stays as it is, so `password` can stay
 * out of a change of `host`. Airflow answers `password` as `***`, and it stays `Redacted`, as
 * does `extra`, which can hold credentials.
 *
 * Bind this operation to an {@link Instance} and an `AirflowClient` in a Function/Worker init
 * phase and provide {@link SetConnectionHttp}.
 *
 * Calls sign in as an OAuth2 client of the instance's identity provider, so this grants no STACKIT
 * role and creates no service account: it exchanges the client's token for a session at the
 * instance, as STACKIT's docs describe. The instance's identity provider has to be `oauth2` with
 * `apiAudience` set, the client's token has to carry that audience, and the provider's roles claim
 * decides what Airflow lets the client do: changing a connection takes `Op` or `Admin`.
 *
 * It calls Airflow's own REST API (`/api/v2`) at the instance's `url`, which needs Airflow 3. On
 * an Airflow 2 instance each call fails with `ConfigError`.
 *
 * ### Setting a Connection
 * **Example:** Give DAGs a database connection from a Cloudflare Worker
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
 *     const password = yield* Config.Redacted("REPORTS_DB_PASSWORD");
 *     const setConnection = yield* Stackit.Workflows.SetConnection(airflow, {
 *       discoveryEndpoint: "https://login.example.com/realms/acme/.well-known/openid-configuration",
 *       clientId: "reports-api",
 *       clientSecret: yield* Config.Redacted("AIRFLOW_CLIENT_SECRET"),
 *     });
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const connection = yield* setConnection({
 *           connection_id: "reports_db",
 *           conn_type: "postgres",
 *           host: "db.example.com",
 *           port: 5432,
 *           login: "reports",
 *           password,
 *         });
 *         return yield* HttpServerResponse.json({ id: connection.connection_id });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Workflows.SetConnectionHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Workflows
 */
export interface SetConnection extends Binding.Service<
  SetConnection,
  "Stackit.Workflows.SetConnection",
  (
    instance: Instance,
    client: AirflowClient,
  ) => Effect.Effect<
    (
      request: SetConnectionRequest,
    ) => Effect.Effect<
      rest.ConnectionResponse,
      rest.PatchConnectionError | rest.CreateConnectionError,
      RuntimeContext
    >
  >
> {}

export const SetConnection = Binding.Service<SetConnection>("Stackit.Workflows.SetConnection");
