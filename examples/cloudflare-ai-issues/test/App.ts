import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { WebApi } from "../src/Board/WebApi.api.ts";
import {
  type Flags,
  init,
  type Message,
  type Model,
  subscriptions,
  update,
} from "../web/src/Issue.ts";

type Client = (typeof WebApi)["Client"]["Identifier"];

/**
 * Run the web page without a browser: its own `init`, `update`, Commands and
 * Subscriptions, against whatever board the `WebApi` client reaches. Only
 * the view is left out. It stops when the scope closes.
 */
export const open = Effect.fn(function* (flags: Flags) {
  const started = init(flags);
  let current: Model = started.model;
  const models = yield* SubscriptionRef.make(current);

  const dispatch = (message: Message): Effect.Effect<void, never, Client> =>
    Effect.gen(function* () {
      const next = update(current, message);
      current = next.model;
      yield* SubscriptionRef.set(models, current);
      // Each Command runs in the background, and its Message is dispatched in turn.
      for (const command of next.commands ?? []) {
        yield* Effect.forkDetach(Effect.flatMap(command.effect, dispatch));
      }
    });

  for (const entry of Object.values(subscriptions)) {
    const read = () => entry.modelToDependencies(current);
    yield* (
      entry.dependenciesToStream as (
        dependencies: unknown,
        read: () => unknown,
      ) => Stream.Stream<Message, never, Client>
    )(read(), read).pipe(Stream.runForEach(dispatch), Effect.forkScoped);
  }

  return {
    /** What a click or a keystroke does. */
    dispatch,
    /** The Model once it satisfies `predicate`. */
    until: (predicate: (model: Model) => boolean) =>
      SubscriptionRef.changes(models).pipe(
        Stream.filter(predicate),
        Stream.runHead,
        Effect.map(() => current),
        Effect.timeout("90 seconds"),
        Effect.orDie,
      ),
  };
});
