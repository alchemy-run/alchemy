import type * as rest from "@distilled.cloud/stackit/dremio_rest";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { User } from "./User.ts";

export interface GetJobRequest extends rest.GetJobRequest {}

/**
 * Runtime binding for Dremio's `GET /api/v3/job/{id}`: read a job's state.
 *
 * `COMPLETED`, `CANCELED` and `FAILED` are final; every other state means it is still running. A
 * `FAILED` job says why in `errorMessage`.
 *
 * Bind this operation to a {@link User} in a Function/Worker init phase and provide
 * {@link GetJobHttp}.
 *
 * Calls log in to Dremio as the bound user, so this grants no STACKIT role and creates no
 * service account: the user's name and password travel through the host's environment, with the
 * password kept `Redacted`. A `Stackit.Dremio.User` is an admin of its instance, so the limit
 * here is the client's surface, not a permission. The host's egress IP has to be in the
 * instance's `acl`, unless that list is empty.
 *
 * It calls Dremio's own REST API at the instance's `endpoints.ui`.
 *
 * ### Reading a Job
 * **Example:** Report a job's state from a Cloudflare Worker
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
 *     const getJob = yield* Stackit.Dremio.GetJob(analyst);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const request = yield* HttpServerRequest;
 *         const jobId = new URL(request.url, "http://worker").searchParams.get("jobId") ?? "";
 *         const job = yield* getJob({ id: jobId });
 *         return yield* HttpServerResponse.json({ state: job.jobState, error: job.errorMessage });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Dremio.GetJobHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Dremio
 */
export interface GetJob extends Binding.Service<
  GetJob,
  "Stackit.Dremio.GetJob",
  (
    user: User,
  ) => Effect.Effect<
    (request: GetJobRequest) => Effect.Effect<rest.Job, rest.GetJobError, RuntimeContext>
  >
> {}

export const GetJob = Binding.Service<GetJob>("Stackit.Dremio.GetJob");
