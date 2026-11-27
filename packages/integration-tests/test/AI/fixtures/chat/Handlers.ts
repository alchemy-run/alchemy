import type * as AI from "@alchemy.run/ai";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ChatError, ChatRpcs } from "./Rpcs.ts";

const failed = (error: AI.NotStarted | AI.HarnessError) =>
  ChatError.make({ message: error._tag === "NotStarted" ? "Not started" : error.message });

/** Each procedure is one method of the session. */
export const ChatHandlers = (session: AI.Session) =>
  ChatRpcs.toLayer({
    send: ({ text, requestId }) => session.send(text, { requestId }).pipe(Effect.mapError(failed)),
    steer: ({ text, requestId }) =>
      session.steer(text, { requestId }).pipe(Effect.mapError(failed)),
    withdraw: ({ id }) => session.withdraw(id).pipe(Effect.mapError(failed)),
    interrupt: () => session.interrupt.pipe(Effect.mapError(failed)),
    events: ({ after }) => session.events({ after }).pipe(Stream.mapError(failed)),
    history: (options) => session.history(options).pipe(Effect.mapError(failed)),
  });
