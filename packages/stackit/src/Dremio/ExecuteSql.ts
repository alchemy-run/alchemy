import type * as rest from "@distilled.cloud/stackit/dremio_rest";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { User } from "./User.ts";

export interface ExecuteSqlRequest extends rest.SubmitSqlRequest {}

/**
 * Runtime binding for Dremio's `POST /api/v3/sql`: submit a SQL statement, which starts a job.
 *
 * It answers with the job's id as soon as the job exists, and a statement that doesn't parse or
 * names a missing table still gets one. Follow it with `GetJob`, which reports `FAILED` and why,
 * and read the rows of a `COMPLETED` job with `GetJobResults`.
 *
 * Bind this operation to a {@link User} in a Function/Worker init phase and provide
 * {@link ExecuteSqlHttp}.
 *
 * Calls log in to Dremio as the bound user, so this grants no STACKIT role and creates no
 * service account: the user's name and password travel through the host's environment, with the
 * password kept `Redacted`. A `Stackit.Dremio.User` is an admin of its instance, so the limit
 * here is the client's surface, not a permission. The host's egress IP has to be in the
 * instance's `acl`, unless that list is empty.
 *
 * It calls Dremio's own REST API at the instance's `endpoints.ui`.
 *
 * ### Submitting a Statement
 * **Example:** Start a job from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Alchemy from "alchemy";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Lakehouse = Stackit.Dremio.Instance("Lakehouse", {});
 * export const Analyst = Effect.gen(function* () {
 *   const lakehouse = yield* Lakehouse;
 *   const password = yield* Alchemy.Random("AnalystPassword");
 *   return yield* Stackit.Dremio.User("Analyst", {
 *     instanceId: lakehouse.instanceId,
 *     email: "analyst@example.com",
 *     firstName: "Ada",
 *     lastName: "Analyst",
 *     password: password.text,
 *   });
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const analyst = yield* Analyst;
 *     const executeSql = yield* Stackit.Dremio.ExecuteSql(analyst);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const job = yield* executeSql({ sql: "SELECT 1 AS answer" });
 *         return yield* HttpServerResponse.json({ jobId: job.id });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Dremio.ExecuteSqlHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Dremio
 */
export interface ExecuteSql extends Binding.Service<
  ExecuteSql,
  "Stackit.Dremio.ExecuteSql",
  (
    user: User,
  ) => Effect.Effect<
    (
      request: ExecuteSqlRequest,
    ) => Effect.Effect<rest.SubmitSqlResponse, rest.SubmitSqlError, RuntimeContext>
  >
> {}

export const ExecuteSql = Binding.Service<ExecuteSql>("Stackit.Dremio.ExecuteSql");
