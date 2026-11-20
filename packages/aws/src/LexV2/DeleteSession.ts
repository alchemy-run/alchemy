import * as lexr from "@distilled.cloud/aws/lex-runtime-v2";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeLexAliasHttpBinding } from "./BindingHttp.ts";
import type { BotAlias } from "./BotAlias.ts";

/**
 * The `DeleteSession` request with the binding-injected `botId` and
 * `botAliasId` removed.
 */
export interface DeleteSessionRequest extends Omit<
  lexr.DeleteSessionRequest,
  "botId" | "botAliasId"
> {}

/**
 * Runtime binding for `lex:DeleteSession` — end a conversation with an
 * Amazon Lex V2 bot alias, discarding its session state so the next user
 * input starts a fresh conversation.
 *
 * ### Managing Sessions
 * **Example:** Reset a User's Conversation
 * ```typescript
 * // init
 * const deleteSession = yield* AWS.LexV2.DeleteSession(alias);
 *
 * // runtime
 * yield* deleteSession({
 *   localeId: "en_US",
 *   sessionId: "user-123",
 * });
 * ```
 *
 * @binding
 */
export interface DeleteSession extends Binding.Service<
  DeleteSession,
  "AWS.LexV2.DeleteSession",
  (
    alias: BotAlias,
  ) => Effect.Effect<
    (
      request: DeleteSessionRequest,
    ) => Effect.Effect<lexr.DeleteSessionResponse, lexr.DeleteSessionError>
  >
> {}

export const DeleteSession = Binding.Service<DeleteSession>("AWS.LexV2.DeleteSession");

/**
 * HTTP implementation of {@link DeleteSession} — calls the `lex-runtime-v2`
 * `DeleteSession` operation with the Lambda role's credentials and grants
 * the host `lex:DeleteSession` on the alias.
 */
export const DeleteSessionHttp = Layer.effect(
  DeleteSession,
  makeLexAliasHttpBinding<
    DeleteSessionRequest,
    lexr.DeleteSessionResponse,
    lexr.DeleteSessionError
  >({
    capability: "DeleteSession",
    iamActions: ["lex:DeleteSession"],
    operation: lexr.deleteSession,
  }),
);
