import type * as router from "@distilled.cloud/stackit/telemetry_router";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Router } from "./Router.ts";

export interface ListAccessTokensRequest extends Omit<
  router.ListAccessTokensRequest,
  "projectId" | "regionId" | "telemetryRouterId"
> {}

/**
 * Runtime binding for Telemetry Router `listAccessTokens`: list one page of the
 * access tokens of a router, without their values. Pass `pageToken` from a
 * response's `nextPageToken` to read the next page.
 *
 * Bind this operation to a {@link Router} in a Function/Worker init phase and
 * provide {@link ListAccessTokensHttp}. It works on any host. A foreign host signs
 * with a service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `telemetry-router.access-token.list` on the
 * project of the bound resource, the narrowest scope STACKIT binds roles on, so it
 * reaches that whole project. The deployer needs `iam.role.add` on that scope to
 * define the role.
 *
 * ### Listing Tokens
 * **Example:** Count expired tokens from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const AuditLogs = Stackit.Telemetry.Router("AuditLogs", {});
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const bound = yield* AuditLogs;
 *     const listAccessTokens = yield* Stackit.Telemetry.ListAccessTokens(bound);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { accessTokens } = yield* listAccessTokens({ pageSize: 50 });
 *         return yield* HttpServerResponse.json({ expired: accessTokens.filter((token) => token.status === "expired").length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Telemetry.ListAccessTokensHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Telemetry Router
 * @category Telemetry
 */
export interface ListAccessTokens extends Binding.Service<
  ListAccessTokens,
  "Stackit.Telemetry.ListAccessTokens",
  (
    router: Router,
  ) => Effect.Effect<
    (
      request: ListAccessTokensRequest,
    ) => Effect.Effect<
      router.ListAccessTokensResponse,
      router.ListAccessTokensError,
      RuntimeContext
    >
  >
> {}

export const ListAccessTokens = Binding.Service<ListAccessTokens>(
  "Stackit.Telemetry.ListAccessTokens",
);
