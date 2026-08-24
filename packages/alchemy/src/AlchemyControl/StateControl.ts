import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import type { StateService } from "../State/State.ts";
import {
  deleteState,
  listState,
  readState,
  type StateDeleted,
  type StateInfoInput,
} from "./State.ts";
import { makeStateResolver } from "./StateSession.ts";
import { InvalidControlInput, type ControlError } from "./Surface.ts";

/** Construct state inspection, mutation, and change-stream operations. */
export const makeStateControl = Effect.gen(function* () {
  const resolveState = yield* makeStateResolver;
  const changes = yield* PubSub.unbounded<StateDeleted>({ replay: 32 });

  const resolvedState = (source: Parameters<typeof resolveState>[0]) =>
    resolveState(source).pipe(
      Effect.flatMap((state) =>
        state === undefined
          ? Effect.fail(
              new InvalidControlInput({
                field: "source",
                message:
                  "A state source is required when no State service is injected.",
              }),
            )
          : Effect.succeed(state),
      ),
    );

  return {
    info: (input?: StateInfoInput) =>
      Effect.map(resolvedState(input?.source), (state) => ({
        backend: state.id,
      })),
    list: (input: Parameters<typeof listState>[1]) =>
      Effect.flatMap(resolvedState(input.source), (state) =>
        listState(state, input),
      ),
    read: (input: Parameters<typeof readState>[1]) =>
      Effect.flatMap(resolvedState(input.source), (state) =>
        readState(state, input),
      ),
    delete: (input: Parameters<typeof deleteState>[1]) =>
      Effect.flatMap(resolvedState(input.source), (state) =>
        deleteState(state, input),
      ).pipe(Effect.tap((event) => PubSub.publish(changes, event))),
    changes: Stream.fromPubSub(changes),
  };
});

/** State inspection, mutation, and change-stream operations. */
export class StateControl extends Context.Service<
  StateControl,
  Effect.Success<typeof makeStateControl>
>()("alchemy/AlchemyControl/State") {}

/** Live state control implementation. */
export const StateControlLive = Layer.effect(StateControl, makeStateControl);
