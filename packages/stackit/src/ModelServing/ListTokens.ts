import type * as modelServing from "@distilled.cloud/stackit/model_serving";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Token } from "./Token.ts";

export interface ListTokensRequest extends Omit<
  modelServing.ListTokensRequest,
  "projectId" | "regionId"
> {}

/**
 * Runtime binding for `listTokens`: list the model serving tokens of the bound token's project
 * and region. None of them carries its value. Bind it to a {@link Token} and provide {@link
 * ListTokensHttp}. The project and region are injected into each request, and the host signs
 * with a service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `model-serving.token.list`, on the project holding the
 * token. STACKIT binds roles on projects, folders and organizations, never on one token, so
 * the role reaches every token of the service in the project. The deployer needs
 * `iam.role.add` on the project to define it.
 *
 * ### Listing Tokens
 * **Example:** List the tokens in the project
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
 *     const binding = yield* Stackit.ModelServing.ListTokens(yield* Ai);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { tokens } = yield* binding();
 *         return yield* HttpServerResponse.json(tokens.map((token) => token.name));
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ModelServing.ListTokensHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT AI Model Serving
 * @category ModelServing
 */
export interface ListTokens extends Binding.Service<
  ListTokens,
  "Stackit.ModelServing.ListTokens",
  (
    token: Token,
  ) => Effect.Effect<
    (
      request?: ListTokensRequest,
    ) => Effect.Effect<modelServing.ListTokenResp, modelServing.ListTokensError, RuntimeContext>
  >
> {}

export const ListTokens = Binding.Service<ListTokens>("Stackit.ModelServing.ListTokens");
