import type * as telemetry from "@distilled.cloud/stackit/telemetry_link";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Link } from "./Link.ts";

export interface BackflushOrganizationRequest extends Omit<
  telemetry.CreateOrganizationBackflushJobRequest,
  "organizationId" | "regionId"
> {}

/**
 * Runtime binding for Telemetry Link `createOrganizationBackflushJob`: start a
 * backflush job on the organization's link, from a runtime or a script. STACKIT
 * describes it only as creating a backflush job; what it replays, and from when, is
 * not documented. A job has no delete or cancel.
 *
 * Bind this operation to a {@link Link} whose `scope` is an organization in a
 * Function/Worker init phase and provide {@link BackflushOrganizationHttp}. The link's
 * organization and region are injected into each request. Binding it to a link of
 * another scope fails the deploy. A foreign host signs with a service account key
 * Alchemy creates for it.
 *
 * Access: a custom role holding only `telemetry-link.instance.update`, on the
 * organization. STACKIT binds roles on projects, folders and organizations, and a link
 * has no finer scope. The deployer needs `iam.role.add` on the organization to define
 * it.
 *
 * ### Starting a Backflush
 * **Example:** Start a job on the organization's link from a Cloudflare Worker
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
 *     const backflushOrganization = yield* Stackit.Telemetry.BackflushOrganization(yield* Audit);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const result = yield* backflushOrganization({ displayName: "replay" });
 *         return yield* HttpServerResponse.json({ id: result.id, status: result.status });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Telemetry.BackflushOrganizationHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Telemetry Router
 * @category Telemetry
 */
export interface BackflushOrganization extends Binding.Service<
  BackflushOrganization,
  "Stackit.Telemetry.BackflushOrganization",
  (
    link: Link,
  ) => Effect.Effect<
    (
      request?: BackflushOrganizationRequest,
    ) => Effect.Effect<
      telemetry.BackflushJobResponse,
      telemetry.CreateOrganizationBackflushJobError,
      RuntimeContext
    >
  >
> {}

export const BackflushOrganization = Binding.Service<BackflushOrganization>(
  "Stackit.Telemetry.BackflushOrganization",
);
