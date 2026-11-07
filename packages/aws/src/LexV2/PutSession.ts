import * as lexr from "@distilled.cloud/aws/lex-runtime-v2";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeLexAliasHttpBinding } from "./BindingHttp.ts";
import type { BotAlias } from "./BotAlias.ts";

/**
 * The `PutSession` request with the binding-injected `botId` and
 * `botAliasId` removed. `sessionState` is the new state of the conversation
 * (active intent, slots, dialog action, session attributes).
 */
export interface PutSessionRequest extends Omit<lexr.PutSessionRequest, "botId" | "botAliasId"> {}

/**
 * Runtime binding for `lex:PutSession` — create or overwrite the session
 * state of a conversation with an Amazon Lex V2 bot alias, letting your
 * application steer the dialog (e.g. pre-fill slots or elicit a specific
 * intent).
 *
 * ### Managing Sessions
 * **Example:** Steer the Conversation
 * ```typescript
 * // init
 * const putSession = yield* AWS.LexV2.PutSession(alias);
 *
 * // runtime
 * yield* putSession({
 *   localeId: "en_US",
 *   sessionId: "user-123",
 *   sessionState: {
 *     intent: { name: "OrderPizza", slots: {} },
 *     dialogAction: { type: "ElicitSlot", slotToElicit: "Size" },
 *   },
 * });
 * ```
 *
 * @binding
 */
export interface PutSession extends Binding.Service<
  PutSession,
  "AWS.LexV2.PutSession",
  (
    alias: BotAlias,
  ) => Effect.Effect<
    (request: PutSessionRequest) => Effect.Effect<lexr.PutSessionResponse, lexr.PutSessionError>
  >
> {}

export const PutSession = Binding.Service<PutSession>("AWS.LexV2.PutSession");

/**
 * HTTP implementation of {@link PutSession} — calls the `lex-runtime-v2`
 * `PutSession` operation with the Lambda role's credentials and grants the
 * host `lex:PutSession` on the alias.
 */
export const PutSessionHttp = Layer.effect(
  PutSession,
  makeLexAliasHttpBinding<PutSessionRequest, lexr.PutSessionResponse, lexr.PutSessionError>({
    capability: "PutSession",
    iamActions: ["lex:PutSession"],
    operation: lexr.putSession,
  }),
);
