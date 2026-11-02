import type * as logs from "@distilled.cloud/stackit/logs";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListAccessTokensRequest extends Omit<
  logs.ListAccessTokensRequest,
  "projectId" | "regionId" | "instanceId"
> {}

/**
 * Runtime binding for Logs `listAccessTokens`: list the instance's tokens, for an
 * audit. Values aren't returned, and the API returns the whole list.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link ListAccessTokensHttp}. A foreign host signs with a service account
 * key Alchemy creates for it.
 *
 * Access: a custom role holding only `logs.instance.credentials.list`, on the project
 * holding the instance. STACKIT binds roles on projects, folders and organizations,
 * never on one instance, so the role reaches every Logs instance in the project. The
 * deployer needs `iam.role.add` on the project to define it.
 *
 * ### Listing Tokens
 * **Example:** Count expired tokens from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Logs = Stackit.Logs.Instance("Logs", { acl: ["0.0.0.0/0"] });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const listAccessTokens = yield* Stackit.Logs.ListAccessTokens(yield* Logs);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const result = yield* listAccessTokens({});
 *         return yield* HttpServerResponse.json({ expired: result.tokens.filter((token) => token.status === "expired").length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Logs.ListAccessTokensHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Logs
 * @category Logs
 */
export interface ListAccessTokens extends Binding.Service<
  ListAccessTokens,
  "Stackit.Logs.ListAccessTokens",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: ListAccessTokensRequest,
    ) => Effect.Effect<logs.AccessTokenList, logs.ListAccessTokensError, RuntimeContext>
  >
> {}

export const ListAccessTokens = Binding.Service<ListAccessTokens>("Stackit.Logs.ListAccessTokens");
