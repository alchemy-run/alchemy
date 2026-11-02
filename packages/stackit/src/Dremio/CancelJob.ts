import type * as rest from "@distilled.cloud/stackit/dremio_rest";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { User } from "./User.ts";

export interface CancelJobRequest extends rest.CancelJobRequest {}

/**
 * Runtime binding for Dremio's `POST /api/v3/job/{id}/cancel`: cancel a running job.
 *
 * The job stays readable, with `jobState` `CANCELED`. A job that has already finished fails with
 * `JobNotFound`, like one that doesn't exist.
 *
 * Bind this operation to a {@link User} in a Function/Worker init phase and provide
 * {@link CancelJobHttp}.
 *
 * Calls log in to Dremio as the bound user, so this grants no STACKIT role and creates no
 * service account: the user's name and password travel through the host's environment, with the
 * password kept `Redacted`. A `Stackit.Dremio.User` is an admin of its instance, so the limit
 * here is the client's surface, not a permission. The host's egress IP has to be in the
 * instance's `acl`, unless that list is empty.
 *
 * It calls Dremio's own REST API at the instance's `endpoints.ui`.
 *
 * ### Canceling a Job
 * **Example:** Cancel a job from a Cloudflare Worker
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
 *     const cancelJob = yield* Stackit.Dremio.CancelJob(analyst);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const request = yield* HttpServerRequest;
 *         const jobId = new URL(request.url, "http://worker").searchParams.get("jobId") ?? "";
 *         yield* cancelJob({ id: jobId });
 *         return HttpServerResponse.empty({ status: 204 });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Dremio.CancelJobHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Dremio
 */
export interface CancelJob extends Binding.Service<
  CancelJob,
  "Stackit.Dremio.CancelJob",
  (
    user: User,
  ) => Effect.Effect<
    (
      request: CancelJobRequest,
    ) => Effect.Effect<rest.CancelJobResponse, rest.CancelJobError, RuntimeContext>
  >
> {}

export const CancelJob = Binding.Service<CancelJob>("Stackit.Dremio.CancelJob");
