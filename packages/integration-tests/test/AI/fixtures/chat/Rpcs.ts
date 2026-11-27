import { HistoryOptions, SessionEvent, SessionPage } from "@alchemy.run/ai/Session";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";

/** The session could not do what it was asked. */
export class ChatError extends Schema.TaggedClass<ChatError>()("ChatError", {
  message: Schema.String,
}) {}

const Text = { text: Schema.String, requestId: Schema.String };

/** What the front end may ask of one session. */
export class ChatRpcs extends RpcGroup.make(
  Rpc.make("send", { payload: Text, error: ChatError }),
  Rpc.make("steer", { payload: Text, error: ChatError }),
  Rpc.make("withdraw", { payload: { id: Schema.String }, error: ChatError }),
  Rpc.make("interrupt", { error: ChatError }),
  Rpc.make("events", {
    payload: { after: Schema.optional(Schema.Number) },
    success: SessionEvent,
    error: ChatError,
    stream: true,
  }),
  Rpc.make("history", { payload: HistoryOptions, success: SessionPage, error: ChatError }),
) {}
