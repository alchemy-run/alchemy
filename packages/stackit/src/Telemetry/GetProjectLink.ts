import type * as telemetry from "@distilled.cloud/stackit/telemetry_link";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Link } from "./Link.ts";

export interface GetProjectLinkRequest extends Omit<
  telemetry.GetProjectTelemetryLinkRequest,
  "projectId" | "regionId"
> {}

/**
 * Runtime binding for Telemetry Link `getProjectTelemetryLink`: read the link's
 * status, router and settings. The token isn't part of what this binding is for;
 * `accessToken` on the result is `Redacted` when STACKIT echoes it.
 *
 * Bind this operation to a {@link Link} whose `scope` is a project in a
 * Function/Worker init phase and provide {@link GetProjectLinkHttp}. The link's
 * project and region are injected into each request. Binding it to a link of another
 * scope fails the deploy. A foreign host signs with a service account key Alchemy
 * creates for it.
 *
 * Access: a custom role holding only `telemetry-link.instance.get`, on the project.
 * STACKIT binds roles on projects, folders and organizations, and a link has no finer
 * scope. The deployer needs `iam.role.add` on the project to define it.
 *
 * ### Reading the Link
 * **Example:** Read the status of the project's link from a Cloudflare Worker
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
 *     const getProjectLink = yield* Stackit.Telemetry.GetProjectLink(yield* Audit);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const result = yield* getProjectLink({});
 *         return yield* HttpServerResponse.json({ status: result.status, enabled: result.enabled });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Telemetry.GetProjectLinkHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Telemetry Router
 * @category Telemetry
 */
export interface GetProjectLink extends Binding.Service<
  GetProjectLink,
  "Stackit.Telemetry.GetProjectLink",
  (
    link: Link,
  ) => Effect.Effect<
    (
      request?: GetProjectLinkRequest,
    ) => Effect.Effect<
      telemetry.TelemetryLinkResponse,
      telemetry.GetProjectTelemetryLinkError,
      RuntimeContext
    >
  >
> {}

export const GetProjectLink = Binding.Service<GetProjectLink>("Stackit.Telemetry.GetProjectLink");
