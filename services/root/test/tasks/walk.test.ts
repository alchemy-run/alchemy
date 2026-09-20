/**
 * THE WALK COMBINATOR, SCRIPTED — judge/Walk.ts alone, no network:
 * termination on conviction, the drill (continue) transition and its
 * accumulated findings, the trace's shape, the budget bound (and its
 * hard cap), and the clean fallback when the judge is unreachable.
 */
import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import {
  walk,
  WALK_STEP_CAP,
  type WalkStepOutcome,
} from "../../src/judge/Walk.ts";

interface State {
  readonly findings: ReadonlyArray<string>;
}

const run = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect);

describe("the walk combinator", () => {
  test("commits on a done move — ended `decided`, value carried, trace recorded", async () => {
    const result = await run(
      walk<State, string, never>({
        initial: { findings: [] },
        step: () =>
          Effect.succeed({
            move: { kind: "done", value: "t-1" },
            question: "which task next?",
            answer: "t-1",
            conviction: 0.82,
          } satisfies WalkStepOutcome<State, string>),
        settle: () => "settled",
      }),
    );
    expect(result.ended).toBe("decided");
    expect(result.value).toBe("t-1");
    expect(result.trace.length).toBe(1);
    expect(result.expanded).toEqual([]);
  });

  test("a drill continues the walk — findings accumulate, expanded ids dedupe, then the commit lands", async () => {
    const result = await run(
      walk<State, string, never>({
        initial: { findings: [] },
        step: (state, index) =>
          Effect.succeed(
            index < 2
              ? ({
                  move: {
                    kind: "continue",
                    state: { findings: [...state.findings, `body:${index}`] },
                  },
                  question: `step ${index}`,
                  answer: "leaning t-2 — opened t-2",
                  conviction: 0.4,
                  expanded: ["t-2"],
                } satisfies WalkStepOutcome<State, string>)
              : ({
                  move: {
                    kind: "done",
                    value: `t-2 after ${state.findings.length} findings`,
                  },
                  question: `step ${index}`,
                  answer: "t-2",
                  conviction: 0.9,
                } satisfies WalkStepOutcome<State, string>),
          ),
        settle: () => "settled",
      }),
    );
    expect(result.ended).toBe("decided");
    // the accumulator grew through both drills before the commit
    expect(result.value).toBe("t-2 after 2 findings");
    expect(result.trace.length).toBe(3);
    // the same id drilled twice records once
    expect(result.expanded).toEqual(["t-2"]);
    expect(result.trace[0]!.expanded).toEqual(["t-2"]);
  });

  test("every trace step carries the full shape", async () => {
    const result = await run(
      walk<State, string, never>({
        initial: { findings: [] },
        step: () =>
          Effect.succeed({
            move: { kind: "done", value: "t-1" },
            question: "q",
            answer: "a",
            conviction: 0.5,
            expanded: ["t-9"],
          } satisfies WalkStepOutcome<State, string>),
        settle: () => "settled",
      }),
    );
    const step = result.trace[0]!;
    expect(step.question).toBe("q");
    expect(step.answer).toBe("a");
    expect(step.conviction).toBe(0.5);
    expect(step.expanded).toEqual(["t-9"]);
    expect(typeof step.elapsedMs).toBe("number");
    expect(step.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  test("a walk that never commits terminates on its budget — settle('budget') decides", async () => {
    let asked = 0;
    const result = await run(
      walk<State, string, never>({
        initial: { findings: [] },
        budget: 3,
        step: (state) =>
          Effect.sync(() => {
            asked += 1;
            return {
              move: {
                kind: "continue",
                state: { findings: [...state.findings, "more"] },
              },
              question: "again?",
              answer: "again",
              conviction: 0.3,
            } satisfies WalkStepOutcome<State, string>;
          }),
        settle: (state, ended) => `${ended}:${state.findings.length}`,
      }),
    );
    expect(asked).toBe(3);
    expect(result.ended).toBe("budget");
    expect(result.value).toBe("budget:3");
    expect(result.trace.length).toBe(3);
  });

  test("the budget is clamped to the hard step cap", async () => {
    let asked = 0;
    const result = await run(
      walk<State, string, never>({
        initial: { findings: [] },
        budget: 10_000,
        step: (state) =>
          Effect.sync(() => {
            asked += 1;
            return {
              move: { kind: "continue", state },
              question: "again?",
              answer: "again",
              conviction: 0,
            } satisfies WalkStepOutcome<State, string>;
          }),
        settle: () => "capped",
      }),
    );
    expect(asked).toBe(WALK_STEP_CAP);
    expect(result.ended).toBe("budget");
  });

  test("an unreachable judge aborts cleanly — settle('fallback') decides, the walk never throws", async () => {
    const result = await run(
      walk<State, string, never>({
        initial: { findings: ["kept"] },
        step: () =>
          Effect.succeed({
            move: { kind: "abort" },
            question: "which task next?",
            answer: "judge unreachable",
            conviction: 0,
          } satisfies WalkStepOutcome<State, string>),
        settle: (state, ended) => `${ended}:${state.findings[0]}`,
      }),
    );
    expect(result.ended).toBe("fallback");
    expect(result.value).toBe("fallback:kept");
    expect(result.trace.length).toBe(1);
    expect(result.trace[0]!.answer).toBe("judge unreachable");
  });
});
