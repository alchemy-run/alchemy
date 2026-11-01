import type * as router from "@distilled.cloud/stackit/telemetry_router";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { AccessToken } from "./AccessToken.ts";

export interface GetAccessTokenRequest extends Omit<
  router.GetAccessTokenRequest,
  "projectId" | "regionId" | "telemetryRouterId" | "accessTokenId"
> {}

/**
 * Runtime binding for Telemetry Router `getAccessToken`: read an access token's
 * status and expiry, so a host can warn before it runs out. The token's value isn't
 * in the answer: STACKIT only returns it on create.
 *
 * Bind this operation to a {@link AccessToken} in a Function/Worker init phase and
 * provide {@link GetAccessTokenHttp}. It works on any host. A foreign host signs
 * with a service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `telemetry-router.access-token.get` on the
 * project of the bound resource, the narrowest scope STACKIT binds roles on, so it
 * reaches that whole project. The deployer needs `iam.role.add` on that scope to
 * define the role.
 *
 * ### Checking a Token
 * **Example:** Report a token's expiry from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const AuditLogs = Stackit.Telemetry.Router("AuditLogs", {});
 * export const LinkToken = AuditLogs.pipe(
 *   Effect.flatMap((router) =>
 *     Stackit.Telemetry.AccessToken("LinkToken", { routerId: router.routerId }),
 *   ),
 * );
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const bound = yield* LinkToken;
 *     const getAccessToken = yield* Stackit.Telemetry.GetAccessToken(bound);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* getAccessToken({});
 *         return yield* HttpServerResponse.json({ status: live.status, expires: live.expirationTime });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Telemetry.GetAccessTokenHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Telemetry Router
 * @category Telemetry
 */
export interface GetAccessToken extends Binding.Service<
  GetAccessToken,
  "Stackit.Telemetry.GetAccessToken",
  (
    token: AccessToken,
  ) => Effect.Effect<
    (
      request: GetAccessTokenRequest,
    ) => Effect.Effect<router.GetAccessTokenResponse2, router.GetAccessTokenError, RuntimeContext>
  >
> {}

export const GetAccessToken = Binding.Service<GetAccessToken>("Stackit.Telemetry.GetAccessToken");
