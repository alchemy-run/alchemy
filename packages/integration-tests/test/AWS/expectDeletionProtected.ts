import { assert, expect } from "@alchemy.run/test";
import type { ScratchStack } from "@alchemy.run/test/Alchemy";
import type { DestroyError } from "alchemy/Apply";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

/**
 * Runs `stack.destroy()` against a resource deployed with deletion protection
 * on and expects the delete to fail with the typed `tag` — the engine leaves
 * the resource in state, and nothing else in the stack is touched.
 */
export const expectDeletionProtected = Effect.fn(function* (
  stack: ScratchStack,
  options: { logicalId: string; tag: string },
) {
  const error = yield* Effect.flip(stack.destroy());
  assert(error._tag === "DestroyError");
  const failures: DestroyError["failures"] = error.failures;
  expect(failures.map((failure) => failure.logicalId)).toEqual([options.logicalId]);
  expect(Cause.squash(failures[0]!.cause)).toMatchObject({ _tag: options.tag });
});
