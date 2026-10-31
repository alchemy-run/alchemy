import { replay, run } from "@alchemy.run/domain/Explore";
/**
 * Search soundness on tiny models: exact counts, the root, the depth bound,
 * engine errors, determinism, replay.
 */
import { describe, expect, it } from "@alchemy.run/test";
import * as M from "./Models.ts";

describe("known counts", () => {
  it("two one-shot independent bits: 4 states, 4 transitions, exhausted", async () => {
    const r = await run(M.twoBits);
    expect([r.states, r.transitions, r.coverage._tag]).toEqual([4, 4, "Exhausted"]);
  });

  it("a three-value choice gives 3 leaves; a 2-then-(3|2) choice gives 5", async () => {
    const r = await run(M.choices);
    // root + 3 + 5 + 3×5 = 24 states; 3 + 5 + 15 + 15 = 38 transitions.
    expect([r.states, r.transitions]).toEqual([24, 38]);
  });

  it("exact identity agrees with the digest and sees no collision", async () => {
    const a = await run(M.jobScenario({ ids: ["J1", "J2"] }));
    const b = await run(M.jobScenario({ ids: ["J1", "J2"] }), { identity: "exact" });
    expect(b.states).toBe(a.states);
    expect(b.identity!.collisions).toBe(0);
  });
});

describe("root and depth", () => {
  it("an invalid root with no moves is a violation, at path length 0", async () => {
    const r = await run(M.badRoot);
    expect(r.violations.map((v) => [v.rule, v.trace.steps.length])).toEqual([["ROOT", 0]]);
    expect(r.coverage._tag).toBe("Exhausted");
  });

  it("the depth graph: BFS reaches bad within depth 3", async () => {
    const bfs = await run(M.depthGraph);
    expect(bfs.violations.map((v) => v.rule)).toEqual(["BAD"]);
    expect(bfs.violations[0]!.trace.steps.length).toBe(3);
  });

  it("a depth limit that cuts an enabled move is WithinDepth, not Exhausted", async () => {
    const r = await run({ ...M.depthGraph, bounds: { depth: 2 } });
    expect(r.coverage).toEqual({ _tag: "WithinDepth", depth: 2 });
  });
});

describe("engine errors are never a clean result", () => {
  const cases: Array<[string, Parameters<typeof run>[0], string]> = [
    ["async effect", M.asyncActor, "AsyncEffect"],
    ["Clock.sleep", M.sleepActor, "ClockSleep"],
    ["crypto.randomUUID", M.randomActor, "HiddenRandomness"],
    ["a Date in fake state", M.dateActor, "NonJsonState"],
  ];
  for (const [name, scenario, kind] of cases)
    it(name, async () => {
      const r = await run(scenario);
      expect(r.coverage).toEqual({ _tag: "CutOff", reason: "engine-error" });
      expect(r.engineErrors.map((e) => e.kind)).toContain(kind as never);
    });

  it("a layer with hidden state (a counter in a policy's command ids) is found by the second-build replay", async () => {
    const r = await run(M.leaky, { freshEvery: 1 });
    expect(r.coverage._tag).toBe("CutOff");
    expect(r.engineErrors.map((e) => e.kind)).toContain("HiddenState");
  });
});

describe("determinism and replay", () => {
  it("the same scenario twice: the same counts and the same traces", async () => {
    const a = await run(M.jobScenario({ ids: ["J1", "J2"], rules: [M.JOB_ARMED] }));
    const b = await run(M.jobScenario({ ids: ["J1", "J2"], rules: [M.JOB_ARMED] }));
    expect([b.states, b.transitions]).toEqual([a.states, a.transitions]);
    expect(b.violations.map((v) => v.trace)).toEqual(a.violations.map((v) => v.trace));
  });

  it("the same swarm seed and walk count give the same hits", async () => {
    const opts = { search: { kind: "swarm" as const, seeds: [7], walks: 200, depth: 12 } };
    const a = await run(M.jobScenario({ rules: [M.JOB_ARMED] }), opts);
    const b = await run(M.jobScenario({ rules: [M.JOB_ARMED] }), opts);
    expect(a.coverage._tag).toBe("Sampled");
    expect(b.violations.map((v) => v.trace)).toEqual(a.violations.map((v) => v.trace));
    expect(a.violations.map((v) => v.rule).sort()).toEqual(["JOB-ARMED", "TIMER-REARM"]);
  });

  it("replay on a fresh build checks every digest and the rule; a changed trace is refused", async () => {
    const s = M.jobScenario({ rules: [M.JOB_ARMED] });
    const r = await run(s);
    const v = r.violations.find((x) => x.rule === "JOB-ARMED")!;
    const ok = await replay(s, v.trace);
    expect(ok.breaks.map(([id]) => id)).toContain("JOB-ARMED");
    const bad = {
      ...v.trace,
      steps: v.trace.steps.map((st, i) => (i === 2 ? { ...st, digest: "0".repeat(32) } : st)),
    };
    await expect(replay(s, bad)).rejects.toThrow(/HiddenState/);
    const shorter = { ...v.trace, steps: v.trace.steps.slice(0, -1) };
    await expect(replay(s, shorter)).rejects.toThrow(/does not break/);
  });
});
