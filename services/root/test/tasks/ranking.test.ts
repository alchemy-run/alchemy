/**
 * SOFT HUMAN RANKING, SCRIPTED — the deterministic edges of the
 * walk scheduler (Scheduler.ts) over the desk world: the drag's
 * one-row hint math, the hint-then-FIFO fallback (unreachable or
 * unsure judge), the judge's recorded deviation from the human's
 * dragged order (through the focused two-option gate), and the
 * worked-by memory that feeds a desk's `recent` even after review
 * re-desks its completed tasks.
 */
import { RuntimeContext } from "alchemy";
import type * as TypeSafe from "alchemy/TypeSafe";
import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { pump } from "../../src/tasks/Desks.ts";
import { rerank } from "../../src/tasks/Scheduler.ts";
import { deskWorld, QUEUE } from "../../eval/world.ts";

const provide = <A>(effect: Effect.Effect<A, never, RuntimeContext>) =>
  Effect.runPromise(effect.pipe(Effect.provide(RuntimeContext.phantom)));

const runPump = (world: ReturnType<typeof deskWorld>) =>
  provide(pump(world.deps, QUEUE));

const runRerank = (world: ReturnType<typeof deskWorld>) =>
  provide(
    rerank(
      world.deps.query,
      world.deps.board(QUEUE.slug),
      QUEUE.worker.slug,
    ),
  );

/**
 * A scripted judge for the WALK questions: the pick fan-out
 * (`next`+`probe`) chooses by `pick` over the human signal's two ids
 * at the given confidence (probe answers `enough` — no drilling),
 * and the focused two-option gate (`pair`) answers the same way with
 * the confidence as the winner's probability mass. Review and
 * disposition questions answer like the world's own scripted query.
 */
const rankJudge = (options: {
  readonly pick: "above" | "below";
  readonly confidence: number;
}) =>
  ((questions: Record<string, unknown>, opts: {
    state: Record<string, unknown>;
  }) =>
    Effect.sync(() => {
      const chooseHuman = () => {
        const match = /sam ordered (\S+) above (\S+)/.exec(
          String(opts.state.human ?? ""),
        );
        if (match === null) throw new Error("no human signal to pick from");
        return options.pick === "above" ? match[1]! : match[2]!;
      };
      if ("next" in questions) {
        const value = chooseHuman();
        return {
          value: { next: value, probe: "enough" },
          answers: {
            next: {
              choice: value,
              confidence: options.confidence,
              probabilities: { [value]: options.confidence },
            },
            probe: { choice: "enough", confidence: 0.9 },
          },
        };
      }
      if ("pair" in questions) {
        const value = chooseHuman();
        return {
          value: { pair: value },
          answers: {
            pair: {
              choice: value,
              confidence: options.confidence,
              probabilities: { [value]: options.confidence },
            },
          },
        };
      }
      if ("changes" in questions) {
        return { value: { changes: false }, answers: { changes: { noul: 0.05 } } };
      }
      if ("disposition" in questions) {
        return {
          value: { disposition: "complete" },
          answers: { disposition: { confidence: 0.9 } },
        };
      }
      throw new Error("unscripted question");
    })) as unknown as typeof TypeSafe.SystemOne.Service;

describe("soft human ranking", () => {
  test("a drag writes ONE hint row; the fallback rank honors hint-then-FIFO; the claim pops the human's top", async () => {
    const world = deskWorld();
    world.file("t-1", "fix(a): first", "first", ["org"]);
    world.file("t-2", "fix(b): second", "second", ["org"]);
    world.file("t-3", "fix(c): third", "third", ["org"]);

    // sam drags t-3 to the top — exactly one row gains a hint
    expect(world.reorder("t-3", { before: "t-1" })).toBeDefined();
    expect(world.task("t-3").hint).toBeDefined();
    expect(world.task("t-1").hint).toBeUndefined();
    expect(world.task("t-2").hint).toBeUndefined();
    expect(world.kindsOf("t-3")).toContain("reordered");

    // the world's scripted query cannot answer rank questions —
    // tryQuery degrades the re-rank to hint-then-FIFO
    await runRerank(world);
    expect(world.ready().map((task) => task.id)).toEqual([
      "t-3",
      "t-1",
      "t-2",
    ]);
    expect(world.task("t-3").rank).toBe(1);
    expect(world.task("t-3").rankWhy).toBe("sam's order");
    expect(world.task("t-1").rankWhy).toBe("fifo — oldest ready");
    // the top pick wears the NEXT stamp for the desk (width 1)
    expect(world.task("t-3").nextFor).toBe("engineer");
    expect(world.task("t-1").nextFor).toBeUndefined();

    // and the desk loop claims in exactly that order — zero judging
    // on the claim path
    for (const id of ["t-3", "t-1", "t-2"]) {
      world.answerFor("engineer", id, `done.\nDISPOSITION: complete — ${id}`);
      world.answerFor("reviewer", id, "LGTM.");
    }
    await runPump(world);
    expect(
      world.dispatches
        .filter((entry) => entry.member === "engineer")
        .map((entry) => entry.task),
    ).toEqual(["t-3", "t-1", "t-2"]);
  });

  test("the judge may deviate from the human's dragged order — recorded on the why line", async () => {
    const world = deskWorld({
      query: rankJudge({ pick: "below", confidence: 0.9 }),
    });
    world.file("t-a", "feat(forge): tree snapshot API", "the prerequisite", [
      "forge",
    ]);
    world.file("t-b", "feat(forge): browser renders the tree", "follows t-a", [
      "forge",
    ]);
    // sam drags the DEPENDENT task on top…
    world.reorder("t-b", { before: "t-a" });

    // …but the judge ranks the prerequisite first, out loud
    await runRerank(world);
    expect(world.ready().map((task) => task.id)).toEqual(["t-a", "t-b"]);
    expect(world.task("t-a").rank).toBe(1);
    expect(world.task("t-a").rankWhy).toBe("judge: before t-b");
    expect(world.task("t-b").rankWhy).toBe("follows t-a (same forge)");
    expect(world.task("t-a").nextFor).toBe("engineer");

    // the pick's WALK TRACE landed with the rank — the pick step and
    // the two-option override gate, in order
    const write = world.rankWrites.at(-1)!;
    const trace = write.entries.find((entry) => entry.id === "t-a")?.trace;
    expect(trace).toBeDefined();
    expect(trace!.length).toBe(2);
    expect(trace![0]!.answer).toBe("t-a");
    expect(trace![1]!.question).toContain("override sam's order?");
    expect(trace![1]!.conviction).toBeCloseTo(0.9);
  });

  test("a sure-but-unconvinced judge keeps sam's order for the pair — no deviation, no fallback", async () => {
    // ≥ SURE (no fallback) but < DEVIATE: the drag is the default
    // the judge must BEAT, not a coin-flip peer
    const world = deskWorld({
      query: rankJudge({ pick: "below", confidence: 0.6 }),
    });
    world.file("t-a", "feat(forge): tree snapshot API", "the prerequisite", [
      "forge",
    ]);
    world.file("t-b", "feat(forge): browser renders the tree", "follows t-a", [
      "forge",
    ]);
    world.reorder("t-b", { before: "t-a" });

    await runRerank(world);
    expect(world.ready().map((task) => task.id)).toEqual(["t-b", "t-a"]);
    expect(world.task("t-b").rankWhy).not.toContain("judge:");
    expect(world.task("t-a").rankWhy).not.toContain("judge:");
  });

  test("an unsure pair keeps hint-then-FIFO — sam's order stands, no deviation", async () => {
    // < SURE: a near-tie pair contributes nothing beyond the human
    // order (an UNREACHABLE judge falls back wholesale instead)
    const world = deskWorld({
      query: rankJudge({ pick: "below", confidence: 0.3 }),
    });
    world.file("t-a", "feat(forge): tree snapshot API", "the prerequisite", [
      "forge",
    ]);
    world.file("t-b", "feat(forge): browser renders the tree", "follows t-a", [
      "forge",
    ]);
    world.reorder("t-b", { before: "t-a" });

    await runRerank(world);
    expect(world.ready().map((task) => task.id)).toEqual(["t-b", "t-a"]);
    expect(world.task("t-b").rankWhy).not.toContain("judge:");
    expect(world.task("t-a").rankWhy).not.toContain("judge:");
  });

  test("an unreachable judge falls back to hint-then-FIFO wholesale", async () => {
    // the world's scripted query cannot answer rank questions at all
    const world = deskWorld();
    world.file("t-a", "fix(a): first", "first", ["org"]);
    world.file("t-b", "fix(b): second", "second", ["org"]);
    world.reorder("t-b", { before: "t-a" });

    await runRerank(world);
    expect(world.ready().map((task) => task.id)).toEqual(["t-b", "t-a"]);
    expect(world.task("t-b").rankWhy).toBe("sam's order");
    expect(world.task("t-a").rankWhy).toBe("fifo — oldest ready");
  });

  test("a desk's recent includes tasks it WORKED, even after review re-desks them", async () => {
    const world = deskWorld();
    world.file("t-1", "fix(r2): CORS drift", "observed rules", ["cloudflare"]);
    world.answer(
      "engineer",
      "Fixed.\nDISPOSITION: complete — CORS diff reads observed rules",
    );
    world.answer("reviewer", "LGTM.");
    await runPump(world);

    // done — and the desk column now names the REVIEWER…
    expect(world.task("t-1").state).toBe("done");
    expect(world.task("t-1").desk).toBe("reviewer");
    expect(world.task("t-1").workedBy).toEqual(["engineer", "reviewer"]);

    // …yet the ENGINEER's recent still carries its finished work —
    // the worked-by memory (the starved-affinity fix)
    const view = await provide(
      world.deps.board(QUEUE.slug).deskState("engineer"),
    );
    expect(
      view.recent.some((entry) => entry.title === "fix(r2): CORS drift"),
    ).toBe(true);
  });
});
