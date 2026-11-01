import type * as telemetry from "@distilled.cloud/stackit/telemetry_link";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Link } from "./Link.ts";

export interface ListProjectBackflushJobsRequest extends Omit<
  telemetry.ListProjectBackflushJobsRequest,
  "projectId" | "regionId"
> {}

/**
 * Runtime binding for Telemetry Link `listProjectBackflushJobs`: list one page of the
 * backflush jobs on the project's link. Pass `pageToken` from a response's
 * `nextPageToken` to read the next page.
 *
 * Bind this operation to a {@link Link} whose `scope` is a project in a
 * Function/Worker init phase and provide {@link ListProjectBackflushJobsHttp}. The
 * link's project and region are injected into each request. Binding it to a link of
 * another scope fails the deploy. A foreign host signs with a service account key
 * Alchemy creates for it.
 *
 * Access: a custom role holding only `telemetry-link.instance.get`, on the project.
 * STACKIT binds roles on projects, folders and organizations, and a link has no finer
 * scope. The deployer needs `iam.role.add` on the project to define it.
 *
 * ### Listing Backflushes
 * **Example:** List jobs from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Audit = Effect.gen(function* () {
 *   const router = yield* Stackit.Telemetry.Router("Audit", {});
 *   const token = yield* Stackit.Telemetry.AccessToken("AuditToken", {
 *     routerId: router.routerId,
 *   });
 *   return yield* Stackit.Telemetry.Link("AuditProject", {
 *     routerId: router.routerId,
 *     accessToken: token.accessToken,
 *   });
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const listProjectBackflushJobs = yield* Stackit.Telemetry.ListProjectBackflushJobs(yield* Audit);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const result = yield* listProjectBackflushJobs({ pageSize: 100 });
 *         return yield* HttpServerResponse.json({ jobs: result.backflushJobs.map((job) => job.status) });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Telemetry.ListProjectBackflushJobsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Telemetry Router
 * @category Telemetry
 */
export interface ListProjectBackflushJobs extends Binding.Service<
  ListProjectBackflushJobs,
  "Stackit.Telemetry.ListProjectBackflushJobs",
  (
    link: Link,
  ) => Effect.Effect<
    (
      request?: ListProjectBackflushJobsRequest,
    ) => Effect.Effect<
      telemetry.ListBackflushJobsResponse,
      telemetry.ListProjectBackflushJobsError,
      RuntimeContext
    >
  >
> {}

export const ListProjectBackflushJobs = Binding.Service<ListProjectBackflushJobs>(
  "Stackit.Telemetry.ListProjectBackflushJobs",
);
