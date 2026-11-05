import { expect } from "@alchemy.run/test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

/**
 * Run a deploy that must fail, and check its cause names each of `needles`
 * (an error tag such as `LookupNotFoundError`, the key that was looked up).
 */
export const expectDeployFails = Effect.fn(function* <A, E, R>(
  deploy: Effect.Effect<A, E, R>,
  needles: ReadonlyArray<string>,
) {
  const exit = yield* Effect.exit(deploy);
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    const pretty = Cause.pretty(exit.cause);
    for (const needle of needles) {
      expect(pretty).toContain(needle);
    }
  }
});

/**
 * A name derived from the test stage that no resource carries, for lookups
 * that must find nothing.
 */
export const missingName = (stage: string, prefix = "missing") =>
  `${prefix}-${stage.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
