import { assert, expect } from "@alchemy.run/test";
import type { ScratchStack } from "@alchemy.run/test/Alchemy";
import type { DestroyError } from "alchemy/Apply";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

/**
 * Runs `stack.destroy()` while a resource has deletion protection on and
 * expects its delete to be refused with the typed `tag`. The provider must not
 * lift the protection itself; the test turns it off and deploys before the
 * destroy that follows.
 */
export const expectDeleteRefused = Effect.fn(function* (
  stack: ScratchStack,
  options: { logicalId: string; tag: string },
) {
  const error = yield* Effect.flip(stack.destroy());
  assert(error._tag === "DestroyError");
  const failures: DestroyError["failures"] = error.failures;
  expect(failures.map((failure) => failure.logicalId)).toEqual([options.logicalId]);
  expect(Cause.squash(failures[0]!.cause)).toMatchObject({ _tag: options.tag });
});
