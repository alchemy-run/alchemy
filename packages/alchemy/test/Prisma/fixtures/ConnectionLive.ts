import * as Effect from "effect/Effect";
import { isActionState, State } from "@/State/State.ts";
import type * as Test from "@/Test/Alchemy";

/**
 * Overwrite fields of a resource row's persisted attributes in any status,
 * including the `old.attr` snapshot an interrupted update keeps. Used to put
 * back the real identity after a deploy failed against a patched row, so
 * `stack.destroy()` can delete the connection.
 */
export const restoreRowAttr = (
  stack: Test.ScratchStack,
  fqn: string,
  patch: Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    const address = { stack: stack.name, stage: stack.stage, fqn };
    const stored = yield* state.get(address);
    if (!stored || isActionState(stored)) {
      return yield* Effect.die(new Error(`Expected a resource state row for '${fqn}'`));
    }
    const patched = (attr: unknown) =>
      attr === undefined ? attr : { ...(attr as object), ...patch };
    const value =
      "old" in stored && stored.old !== undefined && "attr" in stored.old
        ? {
            ...stored,
            attr: patched(stored.attr),
            old: { ...stored.old, attr: patched(stored.old.attr) },
          }
        : { ...stored, attr: patched(stored.attr) };
    yield* state.set({ ...address, value: value as never });
  }).pipe(Effect.provide(stack.state));
