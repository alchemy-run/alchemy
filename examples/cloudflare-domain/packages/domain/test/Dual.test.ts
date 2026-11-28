import { expect, it } from "@effect/vitest";
import { groups } from "./conformance/cases.ts";
import { duals, piped } from "./conformance/dual.ts";
import { check } from "./conformance/run.ts";

// Every function of Effect that is written both ways, `f(self, x)` and
// `pipe(self, f(x))`, is read both ways. The tables call most of them both
// ways; for each one they call only one way, the other is written from it,
// and compared with the real code like any line of a table.

const { missing, groups: derived, tabled } = await piped(groups);

it("every function written both ways is called both ways, in a table or from one", () => {
  expect(duals().length).toBeGreaterThan(450);
  expect(tabled).toBeGreaterThan(250);
  expect(missing).toEqual([]);
});

check(derived);
