import * as Effect from "effect/Effect";
import { isActionState, State } from "@/State/State.ts";
import type * as Test from "@/Test/Alchemy";

/**
 * Overwrite fields of a settled (`created` or `updated`) resource's persisted
 * attributes. The engine plans from persisted attributes, so this stands in
 * for a cloud observation the next deploy must react to.
 */
export const patchSettledAttr = (
  stack: Test.ScratchStack,
  fqn: string,
  patch: Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    const address = { stack: stack.name, stage: stack.stage, fqn };
    const stored = yield* state.get(address);
    if (
      !stored ||
      isActionState(stored) ||
      (stored.status !== "created" && stored.status !== "updated")
    ) {
      return yield* Effect.die(new Error(`Expected a created or updated state row for '${fqn}'`));
    }
    yield* state.set({
      ...address,
      value: { ...stored, attr: { ...(stored.attr as object), ...patch } },
    });
  }).pipe(Effect.provide(stack.state));
