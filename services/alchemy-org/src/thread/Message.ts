import * as AI from "alchemy/AI";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import {
  ENGINEER_TERM,
  MANAGER,
  THREAD_TERM,
  engineerKey,
  shortName,
  threadOf,
} from "./Terms.ts";

const to = AI.Thing("to", S.String)`
  Who hears it: "manager" (the thread's manager), or an engineer of
  this thread by name — "e-1bcde71c" — or by full key.`;

const text = AI.Thing("text", S.String)`
  The message, complete and self-contained — the recipient reads it
  in its own conversation with no other context. Markdown.`;

export class BadRecipient extends Data.TaggedError("BadRecipient")<{
  message: string;
}> {}

/**
 * The one channel between the agents of a thread — the MANAGER and
 * its ENGINEERS talk to each other with it, in both directions and
 * between siblings. A message is delivered into the recipient's own
 * conversation as input: a running agent hears it at its next
 * sampling; a parked one is woken by it. Fire-and-forget — the
 * recipient answers in its own conversation, or messages back.
 */
export class Message extends (AI.Tool<Message>(import.meta)("message")`
  Send ${text} to ${to} — another agent of this thread. It lands in
  the recipient's conversation, marked as yours; they answer there, or
  message you back. Fails with ${BadRecipient} for a recipient that is
  not an agent of this thread (or is yourself).`) {}

/** Delivery over `AI.Sessions.send` by NAME — no agent's Layer in
 *  hand, so both charters hold this without holding each other. */
export const MessageLive = Layer.effect(
  Message,
  Effect.gen(function* () {
    const sessions = yield* AI.Sessions;

    return Effect.fn(function* (input: { to: string; text: string }) {
      const self = yield* AI.Thread;
      // who is speaking: the manager (its key IS the thread id) or an
      // engineer (`<thread>::e-…`)
      const thread = threadOf(self.key) ?? self.key;
      const sender =
        threadOf(self.key) === undefined ? MANAGER : shortName(self.key);
      const target = input.to.trim();
      const recipient =
        target === MANAGER || target === thread
          ? { term: THREAD_TERM, key: thread, name: MANAGER }
          : {
              term: ENGINEER_TERM,
              key: engineerKey(thread, target),
              name: shortName(engineerKey(thread, target)),
            };
      if (
        threadOf(recipient.key) !== undefined &&
        threadOf(recipient.key) !== thread
      ) {
        return yield* Effect.fail(
          new BadRecipient({
            message: `${target} is not an agent of thread ${thread}`,
          }),
        );
      }
      if (recipient.name === sender) {
        return yield* Effect.fail(
          new BadRecipient({ message: `${target} is you` }),
        );
      }
      yield* sessions.send(
        recipient.term,
        recipient.key,
        `[message from ${sender}]\n${input.text}`,
      );
    }) as never;
  }),
);
