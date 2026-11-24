/**
 * A session in a Foldkit app: Commands that act on it, and a Subscription
 * that follows what it does. The app provides `AI.SessionClient` in its
 * runtime resources.
 *
 * @module
 */
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
import type { SessionEvent } from "./Session.ts";
import { followSession, SessionClient } from "./SessionRpcs.ts";

/** What a session Command answers with. `requestId` is the one it was given. */
export const Message = defineMessageUnion({
  /** The session stored the message, or did what was asked. */
  SucceededSession: { requestId: Schema.String },
  /** It did not, or the answer was lost. The same `requestId` can be sent again. */
  FailedSession: { requestId: Schema.String, reason: Schema.String },
});
export type Message = typeof Message.Type;

const answer = <E extends { readonly message: string }>(
  requestId: string,
  effect: Effect.Effect<unknown, E, SessionClient>,
): Effect.Effect<Message, never, SessionClient> =>
  effect.pipe(
    Effect.as(Message.SucceededSession({ requestId })),
    Effect.catchCause((cause) =>
      Effect.succeed(
        Message.FailedSession({
          requestId,
          reason: Option.match(Cause.findErrorOption(cause), {
            onNone: () => "The session did not answer",
            onSome: (error) => error.message,
          }),
        }),
      ),
    ),
  );

const Text = { text: Schema.String, requestId: Schema.String };

/** Queue a message: the session reads it when the turn that is running ends. */
export const Send = Command.define("SendToSession", {
  args: Text,
  messages: [Message],
  execute: ({ text, requestId }) =>
    answer(
      requestId,
      Effect.flatMap(SessionClient, (session) => session.send({ text, requestId })),
    ),
});

/** Steer: the turn that is running reads the message at its next step. */
export const Steer = Command.define("SteerSession", {
  args: Text,
  messages: [Message],
  execute: ({ text, requestId }) =>
    answer(
      requestId,
      Effect.flatMap(SessionClient, (session) => session.steer({ text, requestId })),
    ),
});

/** Take back a queued message, by the `id` a status event lists it with. */
export const Withdraw = Command.define("WithdrawFromSession", {
  args: { id: Schema.String, requestId: Schema.String },
  messages: [Message],
  execute: ({ id, requestId }) =>
    answer(
      requestId,
      Effect.flatMap(SessionClient, (session) => session.withdraw({ id })),
    ),
});

/** Stop the turn that is running. */
export const Interrupt = Command.define("InterruptSession", {
  args: { requestId: Schema.String },
  messages: [Message],
  execute: ({ requestId }) =>
    answer(
      requestId,
      Effect.flatMap(SessionClient, (session) => session.interrupt()),
    ),
});

/** What following a session needs from the app. */
export interface EventsOptions<Model, Message> {
  /** The `seq` of the last item the Model holds. The read resumes after it. */
  readonly cursor: (model: Model) => Option.Option<number>;
  readonly isEnabled?: (model: Model) => boolean;
  /** A status, or one item. Store an item's `seq` as the cursor when you apply it. */
  readonly onEvent: (event: SessionEvent) => Message;
  readonly onFailure: (reason: string) => Message;
}

interface Dependencies {
  readonly cursor: Option.Option<number>;
  readonly isEnabled: boolean;
}

/** A Subscription entry that follows a session. Pass it to `Subscription.make`. */
export interface EventsSubscription<Model, Message> {
  readonly dependenciesSchema: Schema.Struct<{
    cursor: Schema.Schema<Option.Option<number>>;
    isEnabled: typeof Schema.Boolean;
  }>;
  readonly modelToDependencies: (model: Model) => Dependencies;
  readonly keepAliveEquivalence: (left: Dependencies, right: Dependencies) => boolean;
  readonly dependenciesToStream: (
    dependencies: Dependencies,
    readDependencies: () => Dependencies,
  ) => Stream.Stream<Message, never, SessionClient>;
}

/**
 * Follow a session: its status first, then every item after the Model's
 * cursor, then each one as it happens. A changing cursor does not restart
 * the read, and a lost connection resumes after the last item delivered.
 *
 * **Example:** Keep a session's items and status in the Model
 * ```typescript
 * export const subscriptions = Subscription.make<Model, Message, AI.SessionClient>()(() => ({
 *   session: AIFoldkit.events({
 *     cursor: (model: Model) => Array.last(model.items).pipe(Option.map((entry) => entry.seq)),
 *     onEvent: (event): Message => Message.ReceivedSessionEvent({ event }),
 *     onFailure: (reason): Message => Message.FailedSession({ reason }),
 *   }),
 * }));
 * ```
 */
export const events = <Model, Message>(
  options: EventsOptions<Model, Message>,
): EventsSubscription<Model, Message> => ({
  dependenciesSchema: Schema.Struct({
    cursor: Schema.Option(Schema.Number),
    isEnabled: Schema.Boolean,
  }),
  modelToDependencies: (model) => ({
    cursor: options.cursor(model),
    isEnabled: options.isEnabled?.(model) ?? true,
  }),
  keepAliveEquivalence: (left, right) => left.isEnabled === right.isEnabled,
  dependenciesToStream: (_, readDependencies) =>
    Stream.suspend(() => {
      const { cursor, isEnabled } = readDependencies();
      if (!isEnabled) return Stream.empty;
      return followSession(
        Option.match(cursor, { onNone: () => ({}), onSome: (after) => ({ after }) }),
      ).pipe(
        Stream.map(options.onEvent),
        Stream.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Stream.failCause(cause as Cause.Cause<never>)
            : Stream.succeed(
                options.onFailure(
                  Option.match(Cause.findErrorOption(cause), {
                    onNone: () => "The session's events stopped",
                    onSome: (error) => error.message,
                  }),
                ),
              ),
        ),
      );
    }),
});
