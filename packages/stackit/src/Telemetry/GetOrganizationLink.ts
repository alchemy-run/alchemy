import type * as telemetry from "@distilled.cloud/stackit/telemetry_link";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Link } from "./Link.ts";

export interface GetOrganizationLinkRequest extends Omit<
  telemetry.GetOrganizationTelemetryLinkRequest,
  "organizationId" | "regionId"
> {}

/**
 * Runtime binding for Telemetry Link `getOrganizationTelemetryLink`: read the link's
 * status, router and settings. The token isn't part of what this binding is for;
 * `accessToken` on the result is `Redacted` when STACKIT echoes it.
 *
 * Bind this operation to a {@link Link} whose `scope` is an organization in a
 * Function/Worker init phase and provide {@link GetOrganizationLinkHttp}. The link's
 * organization and region are injected into each request. Binding it to a link of
 * another scope fails the deploy. A foreign host signs with a service account key
 * Alchemy creates for it.
 *
 * Access: a custom role holding only `telemetry-link.instance.get`, on the
 * organization. STACKIT binds roles on projects, folders and organizations, and a link
 * has no finer scope. The deployer needs `iam.role.add` on the organization to define
 * it.
 *
 * ### Reading the Link
 * **Example:** Read the status of the organization's link from a Cloudflare Worker
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
 *     const getOrganizationLink = yield* Stackit.Telemetry.GetOrganizationLink(yield* Audit);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const result = yield* getOrganizationLink({});
 *         return yield* HttpServerResponse.json({ status: result.status, enabled: result.enabled });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Telemetry.GetOrganizationLinkHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Telemetry Router
 * @category Telemetry
 */
export interface GetOrganizationLink extends Binding.Service<
  GetOrganizationLink,
  "Stackit.Telemetry.GetOrganizationLink",
  (
    link: Link,
  ) => Effect.Effect<
    (
      request?: GetOrganizationLinkRequest,
    ) => Effect.Effect<
      telemetry.TelemetryLinkResponse,
      telemetry.GetOrganizationTelemetryLinkError,
      RuntimeContext
    >
  >
> {}

export const GetOrganizationLink = Binding.Service<GetOrganizationLink>(
  "Stackit.Telemetry.GetOrganizationLink",
);
