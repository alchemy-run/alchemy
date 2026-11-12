import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import { expect } from "@alchemy.run/test";
import * as Core from "@alchemy.run/test/Core";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

// Fields Galaxy changes on its own after a write.
const volatile = /^(modified|modifiedOn|syncToken|state|nextExecution)$/;

// Redacted values compare by what they hold.
const plain = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value, (_, v: unknown) => (Redacted.isRedacted(v) ? Redacted.value(v) : v)),
  );

/**
 * Plan a role whose description carries the lookup's attributes, in a
 * second stack that never deploys: the plan resolves `Resource.lookup`
 * against Galaxy and writes nothing.
 */
const planLookup = (lookup: Output.Output<unknown> | object) =>
  Core.scratchStack({ providers: StarburstGalaxy.providers() }, "StarburstGalaxyLookupProbe")
    .plan(
      StarburstGalaxy.Role("LookupProbe", {
        description: Output.map(lookup as Output.Output<unknown>, (attrs) =>
          JSON.stringify(plain(attrs)),
        ),
      }),
    )
    .pipe(
      Effect.map((plan) => {
        const node = plan.resources.LookupProbe as { props: { description: string } };
        return JSON.parse(node.props.description) as Record<string, unknown>;
      }),
    );

/**
 * Resolve `lookup` through a planning stack and check its attributes match
 * `expected` (a deploy's output); `ignore` names fields a lookup can't know.
 */
export const expectFound = Effect.fn(function* (
  lookup: Output.Output<unknown> | object,
  expected: object,
  options: { readonly ignore?: ReadonlyArray<string> } = {},
) {
  // A just-created object can read as missing for a few seconds.
  const found = yield* planLookup(lookup).pipe(
    Effect.catchDefect((defect) =>
      Predicate.isTagged(defect, "LookupNotFoundError") ? Effect.fail(defect) : Effect.die(defect),
    ),
    Effect.retry({ times: 6, schedule: Schedule.spaced("5 seconds") }),
  );
  const want = plain(expected) as Record<string, unknown>;
  const mismatches: Record<string, { lookup: unknown; deploy: unknown }> = {};
  for (const [key, value] of Object.entries(want)) {
    if (volatile.test(key) || options.ignore?.includes(key)) continue;
    if (JSON.stringify(found[key]) !== JSON.stringify(value)) {
      mismatches[key] = { lookup: found[key], deploy: value };
    }
  }
  expect(mismatches).toEqual({});
});

/** Resolve `lookup` through a planning stack and check Galaxy has no such object. */
export const expectNotFound = Effect.fn(function* (lookup: Output.Output<unknown> | object) {
  const exit = yield* planLookup(lookup).pipe(Effect.exit);
  expect(Exit.isFailure(exit)).toBe(true);
  expect(String(Exit.isFailure(exit) && exit.cause)).toContain("LookupNotFoundError");
});
