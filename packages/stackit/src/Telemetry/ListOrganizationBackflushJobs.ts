import type * as telemetry from "@distilled.cloud/stackit/telemetry_link";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Link } from "./Link.ts";

export interface ListOrganizationBackflushJobsRequest extends Omit<
  telemetry.ListOrganizationBackflushJobsRequest,
  "organizationId" | "regionId"
> {}

/**
 * Runtime binding for Telemetry Link `listOrganizationBackflushJobs`: list one page of
 * the backflush jobs on the organization's link. Pass `pageToken` from a response's
 * `nextPageToken` to read the next page.
 *
 * Bind this operation to a {@link Link} whose `scope` is an organization in a
 * Function/Worker init phase and provide {@link ListOrganizationBackflushJobsHttp}.
 * The link's organization and region are injected into each request. Binding it to a
 * link of another scope fails the deploy. A foreign host signs with a service account
 * key Alchemy creates for it.
 *
 * Access: a custom role holding only `telemetry-link.instance.get`, on the
 * organization. STACKIT binds roles on projects, folders and organizations, and a link
 * has no finer scope. The deployer needs `iam.role.add` on the organization to define
 * it.
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
 *   return yield* Stackit.Telemetry.Link("AuditOrganization", {
 *     scope: { organizationId: "00000000-0000-0000-0000-000000000000" },
 *     routerId: router.routerId,
 *     accessToken: token.accessToken,
 *   });
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const listOrganizationBackflushJobs = yield* Stackit.Telemetry.ListOrganizationBackflushJobs(yield* Audit);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const result = yield* listOrganizationBackflushJobs({ pageSize: 100 });
 *         return yield* HttpServerResponse.json({ jobs: result.backflushJobs.map((job) => job.status) });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Telemetry.ListOrganizationBackflushJobsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Telemetry Router
 * @category Telemetry
 */
export interface ListOrganizationBackflushJobs extends Binding.Service<
  ListOrganizationBackflushJobs,
  "Stackit.Telemetry.ListOrganizationBackflushJobs",
  (
    link: Link,
  ) => Effect.Effect<
    (
      request?: ListOrganizationBackflushJobsRequest,
    ) => Effect.Effect<
      telemetry.ListBackflushJobsResponse,
      telemetry.ListOrganizationBackflushJobsError,
      RuntimeContext
    >
  >
> {}

export const ListOrganizationBackflushJobs = Binding.Service<ListOrganizationBackflushJobs>(
  "Stackit.Telemetry.ListOrganizationBackflushJobs",
);
