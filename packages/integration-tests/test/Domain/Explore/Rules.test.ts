import { run, type Rule } from "@alchemy.run/domain/Explore";
/** Derived rules, time, crash points and `eventually`. */
import { describe, expect, it } from "@alchemy.run/test";
import * as M from "./Models.ts";

describe("TIMER-REARM (derived, refined)", () => {
  it("finds the stale re-arm with no domain text, in 6 moves", async () => {
    const r = await run(M.jobScenario());
    const v = r.violations.find((x) => x.rule === "TIMER-REARM")!;
    expect(v.trace.steps.length).toBe(6);
    expect(v.path.map((p) => p.label)).toContain("freeze@J1");
  });

  it("a redelivery of the input that armed the timer is not a break", async () => {
    const r = await run(M.jobScenario({ freeze: false, redeliveries: 2 }));
    expect(r.violations.map((v) => v.rule)).toEqual([]);
  });

  it("a re-arm AFTER the command already served the input is not a break", async () => {
    const r = await run(M.jobScenario());
    const v = r.violations.find((x) => x.rule === "TIMER-REARM")!;
    // The fire ran stale (before the unfreeze), never after it.
    const fire = v.path.findIndex((p) => p.kind === "timer");
    const unfreeze = v.path.findIndex((p) => p.label === "unfreeze@J1");
    expect(fire).toBeLessThan(unfreeze);
  });
});

describe("time", () => {
  it("an actor can act at the deadline before the timer fires only with a tick", async () => {
    const without = await run(M.jobScenario({ freeze: false, late: true, rules: [M.LATE_RULE] }));
    const withTick = await run(
      M.jobScenario({ freeze: false, late: true, ticks: 1, rules: [M.LATE_RULE] }),
    );
    expect(without.violations.map((v) => v.rule)).toEqual([]);
    expect(withTick.violations.map((v) => v.rule)).toEqual(["ACTED-LATE"]);
    expect(withTick.violations[0]!.path.map((p) => p.kind)).toContain("tick");
  });
});

describe("crash points", () => {
  it("a crash between two sends of one policy run is reachable only with policy faults", async () => {
    expect((await run(M.twoSends(true))).violations.map((v) => v.rule)).toEqual(["HALF-DONE"]);
    expect((await run(M.twoSends(false))).violations.map((v) => v.rule)).toEqual([]);
  });
});

describe("defects", () => {
  const dying = (retryDefects: ReadonlyArray<string>) => M.dyingPolicy(retryDefects);
  it("a die in a policy is a DEFECT", async () => {
    expect((await run(dying([]))).violations.map((v) => v.rule)).toContain("DEFECT");
  });
  it("a die the profile declares as a retry is a modeled failure, and the report says so", async () => {
    const r = await run(dying(["Refused"]));
    expect(r.violations.map((v) => v.rule)).not.toContain("DEFECT");
    expect(r.violations.map((v) => v.rule)).toContain("DEAD-LETTER");
    expect(r.abstractions.join()).toMatch(/_tag Refused/);
  });
});

describe("eventually", () => {
  const FIRES: Rule = {
    id: "FIRES-WITHIN-2D",
    kind: "eventually",
    when: (s) =>
      s.instances("Job").some(([, st]) => st.deadline !== null && !st.frozen && !st.fired),
    horizonMillis: 2 * 24 * 3_600_000,
    goal: (s) =>
      s.instances("Job").every(([, st]) => st.fired || st.frozen)
        ? undefined
        : "an unfrozen job did not fire within 2 days",
  };
  it("states the business fact without a timer id, and still finds the stale re-arm", async () => {
    const r = await run(M.jobScenario({ rules: [FIRES] }));
    expect(r.violations.map((v) => v.rule)).toContain("FIRES-WITHIN-2D");
  });
  it("holds when nothing freezes", async () => {
    const r = await run(M.jobScenario({ freeze: false, rules: [FIRES] }));
    expect(r.violations.map((v) => v.rule)).toEqual([]);
  });
});
