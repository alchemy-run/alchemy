import type * as rest from "@distilled.cloud/stackit/workflows_airflow";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { AirflowClient } from "./AirflowClient.ts";
import type { Instance } from "./Instance.ts";

export interface SetVariableRequest extends rest.CreateVariableRequest {}

/**
 * Runtime binding for Airflow's `/api/v2/variables`: set a variable that DAGs read, creating it
 * if it doesn't exist. A `description` left out of an update stays as it is. The value stays
 * `Redacted` on the way back, and Airflow may mask it there if its key looks sensitive.
 *
 * Bind this operation to an {@link Instance} and an `AirflowClient` in a Function/Worker init
 * phase and provide {@link SetVariableHttp}.
 *
 * Calls sign in as an OAuth2 client of the instance's identity provider, so this grants no STACKIT
 * role and creates no service account: it exchanges the client's token for a session at the
 * instance, as STACKIT's docs describe. The instance's identity provider has to be `oauth2` with
 * `apiAudience` set, the client's token has to carry that audience, and the provider's roles claim
 * decides what Airflow lets the client do: changing a variable takes `Op` or `Admin`.
 *
 * It calls Airflow's own REST API (`/api/v2`) at the instance's `url`, which needs Airflow 3. On
 * an Airflow 2 instance each call fails with `ConfigError`.
 *
 * ### Setting a Variable
 * **Example:** Point DAGs at a release from a Cloudflare Worker
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
 *     const setVariable = yield* Stackit.Workflows.SetVariable(airflow, {
 *       discoveryEndpoint: "https://login.example.com/realms/acme/.well-known/openid-configuration",
 *       clientId: "reports-api",
 *       clientSecret: yield* Config.redacted("AIRFLOW_CLIENT_SECRET"),
 *     });
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const variable = yield* setVariable({ key: "release", value: "2026.11" });
 *         return yield* HttpServerResponse.json({ key: variable.key });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Workflows.SetVariableHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Workflows
 */
export interface SetVariable extends Binding.Service<
  SetVariable,
  "Stackit.Workflows.SetVariable",
  (
    instance: Instance,
    client: AirflowClient,
  ) => Effect.Effect<
    (
      request: SetVariableRequest,
    ) => Effect.Effect<
      rest.VariableResponse,
      rest.PatchVariableError | rest.CreateVariableError,
      RuntimeContext
    >
  >
> {}

export const SetVariable = Binding.Service<SetVariable>("Stackit.Workflows.SetVariable");
