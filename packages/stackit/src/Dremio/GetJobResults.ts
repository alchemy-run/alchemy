import type * as rest from "@distilled.cloud/stackit/dremio_rest";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { User } from "./User.ts";

export interface GetJobResultsRequest extends rest.GetJobResultsRequest {}

/**
 * Runtime binding for Dremio's `GET /api/v3/job/{id}/results`: read a page of a `COMPLETED` job's
 * rows, as objects keyed by column, up to 500 at a time.
 *
 * It fails with `JobResultsNotReady` for a job in any other state, so wait with `GetJob` first. Page
 * with `offset` and `limit`; `rowCount` is the total.
 *
 * Bind this operation to a {@link User} in a Function/Worker init phase and provide
 * {@link GetJobResultsHttp}.
 *
 * Calls log in to Dremio as the bound user, so this grants no STACKIT role and creates no
 * service account: the user's name and password travel through the host's environment, with the
 * password kept `Redacted`. A `Stackit.Dremio.User` is an admin of its instance, so the limit
 * here is the client's surface, not a permission. The host's egress IP has to be in the
 * instance's `acl`, unless that list is empty.
 *
 * It calls Dremio's own REST API at the instance's `endpoints.ui`.
 *
 * ### Reading the Rows
 * **Example:** Read the first page from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Alchemy from "alchemy";
 * import * as Effect from "effect/Effect";
 * import { HttpServerRequest } from "effect/http/HttpServerRequest";
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
 *     const getJobResults = yield* Stackit.Dremio.GetJobResults(analyst);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const request = yield* HttpServerRequest;
 *         const jobId = new URL(request.url, "http://worker").searchParams.get("jobId") ?? "";
 *         const results = yield* getJobResults({ id: jobId, limit: 100 });
 *         return yield* HttpServerResponse.json({ total: results.rowCount, rows: results.rows });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Dremio.GetJobResultsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Dremio
 */
export interface GetJobResults extends Binding.Service<
  GetJobResults,
  "Stackit.Dremio.GetJobResults",
  (
    user: User,
  ) => Effect.Effect<
    (
      request: GetJobResultsRequest,
    ) => Effect.Effect<rest.JobResults, rest.GetJobResultsError, RuntimeContext>
  >
> {}

export const GetJobResults = Binding.Service<GetJobResults>("Stackit.Dremio.GetJobResults");
