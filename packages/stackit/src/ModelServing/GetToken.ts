import type * as modelServing from "@distilled.cloud/stackit/model_serving";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Token } from "./Token.ts";

export interface GetTokenRequest extends Omit<
  modelServing.GetTokenRequest,
  "projectId" | "regionId" | "tId"
> {}

/**
 * Runtime binding for `getToken`: read a token's state and expiry, to warn before it stops
 * working. It never returns the token's value. Bind it to a {@link Token} and provide {@link
 * GetTokenHttp}. The token's project, region and id are injected into each request, and the
 * host signs with a service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `model-serving.token.get`, on the project holding the
 * token. STACKIT binds roles on projects, folders and organizations, never on one token, so
 * the role reaches every token of the service in the project. The deployer needs
 * `iam.role.add` on the project to define it.
 *
 * ### Reading the Token
 * **Example:** Report when the token expires
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Ai = Stackit.ModelServing.Token("Ai", {});
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const binding = yield* Stackit.ModelServing.GetToken(yield* Ai);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { token } = yield* binding();
 *         return yield* HttpServerResponse.json({ state: token.state, validUntil: token.validUntil });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ModelServing.GetTokenHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT AI Model Serving
 * @category ModelServing
 */
export interface GetToken extends Binding.Service<
  GetToken,
  "Stackit.ModelServing.GetToken",
  (
    token: Token,
  ) => Effect.Effect<
    (
      request?: GetTokenRequest,
    ) => Effect.Effect<modelServing.GetTokenResponse, modelServing.GetTokenError, RuntimeContext>
  >
> {}

export const GetToken = Binding.Service<GetToken>("Stackit.ModelServing.GetToken");
