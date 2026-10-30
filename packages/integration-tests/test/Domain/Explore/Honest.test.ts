import * as Domain from "@alchemy.run/domain";
import {
  assertModelHash,
  modelHashOf,
  replay,
  run,
  toStory,
  type Rule,
} from "@alchemy.run/domain/Explore";
/**
 * Honest results: a rule whose trigger never fired is VACUOUS, a changed
 * model refuses replay, and every report says what it covers and that it is
 * no proof.
 */
import { describe, expect, it } from "@alchemy.run/test";
import * as Schema from "effect/Schema";
import * as M from "./Models.ts";

describe("reachable / VACUOUS", () => {
  const NEVER_LATE: Rule = {
    id: "NEVER-LATE",
    kind: "state",
    reachable: {
      text: "an actor acted late",
      state: (s) => s.instances("Job").some(([, st]) => st.late),
    },
    check: () => undefined,
  };
  const verdict = (r: Awaited<ReturnType<typeof run>>, id: string) =>
    r.ruleVerdicts.find((v) => v.rule === id);

  it("a rule whose trigger the pool never reaches is VACUOUS, not held, and the report lists it", async () => {
    const r = await run(M.jobScenario({ freeze: false, rules: [NEVER_LATE] }));
    expect(r.coverage._tag).toBe("Exhausted");
    expect(verdict(r, "NEVER-LATE")).toMatchObject({
      verdict: "VACUOUS",
      witnessed: false,
      trigger: "an actor acted late",
    });
    expect(r.vacuous).toContain("NEVER-LATE");
  });

  it("the same rule is HELD once the pool reaches the trigger", async () => {
    const r = await run(
      M.jobScenario({ freeze: false, late: true, ticks: 1, rules: [NEVER_LATE] }),
    );
    expect(verdict(r, "NEVER-LATE")).toMatchObject({ verdict: "HELD", witnessed: true });
    expect(r.vacuous).not.toContain("NEVER-LATE");
  });

  it("a step trigger works; a root state trigger counts; a break wins over no witness", async () => {
    const step: Rule = {
      id: "S",
      kind: "state",
      reachable: {
        text: "a fire",
        step: (_s, st) => st.commits.some((c) => c.commandTag === "Fire"),
      },
      check: () => undefined,
    };
    const root: Rule = {
      id: "R",
      kind: "state",
      reachable: { text: "the root", state: () => true },
      check: () => undefined,
    };
    const broken: Rule = {
      id: "B",
      kind: "state",
      reachable: { text: "never", state: () => false },
      check: () => "broken",
    };
    const r = await run(M.jobScenario({ freeze: false, rules: [step, root, broken] }));
    expect(["S", "R", "B"].map((id) => verdict(r, id)?.verdict)).toEqual([
      "HELD",
      "HELD",
      "BROKEN",
    ]);
  });

  it("a cut-off run says NOT-FOUND, never HELD, and a swarm unions its seeds", async () => {
    const seen: Rule = {
      id: "SEEN",
      kind: "state",
      reachable: { text: "armed", state: (s) => s.instances("Job").length > 0 },
      check: () => undefined,
    };
    const cut = await run(M.jobScenario({ ids: ["J1", "J2"], rules: [seen] }), {
      limits: { states: 3 },
    });
    expect(cut.coverage._tag).toBe("CutOff");
    expect(verdict(cut, "SEEN")?.verdict).toBe("NOT-FOUND");
    const swarm = await run(M.jobScenario({ rules: [seen, NEVER_LATE] }), {
      search: { kind: "swarm", seeds: [1, 2], walks: 20, depth: 8 },
    });
    expect(verdict(swarm, "SEEN")?.verdict).toBe("NOT-FOUND");
    expect(swarm.vacuous).toContain("NEVER-LATE");
  });

  it("workers report the same verdicts as one thread", async () => {
    const url = new URL("./Fixture.worker.ts", import.meta.url).href;
    const scenario = M.jobScenario({ ids: ["J1", "J2"], redeliveries: 1, rules: [M.JOB_ARMED] });
    const one = await run(scenario, { batch: 4 });
    const two = await run(scenario, {
      batch: 4,
      workers: { count: 2, url, init: { name: "job2" } },
    });
    expect(two.ruleVerdicts).toEqual(one.ruleVerdicts);
  });
});

describe("modelHash", () => {
  const make = (o: { text?: boolean; extra?: boolean; flip?: boolean; on?: boolean } = {}) => {
    class Done extends Domain.Event("Done", { x: o.text ? Schema.String : Schema.Number }) {}
    class Also extends Domain.Event("Also", {}) {}
    class Do extends Domain.Command("Do", { target: Schema.String, input: {}, events: [Done] }) {}
    class Nope extends Domain.Command("Nope", {
      target: Schema.String,
      input: {},
      events: [Done],
    }) {}
    class More extends Domain.Command("More", {
      target: Schema.String,
      input: {},
      events: [Also],
    }) {}
    const list = [Do, Nope, ...(o.extra ? [More] : [])];
    class A extends Domain.Aggregate("A", {
      id: Schema.String,
      state: Schema.Struct({ n: Schema.Number }),
      initial: { n: 0 },
      commands: (o.flip ? [...list].reverse() : list) as never,
      decide: { Do: () => [], Nope: () => [], ...(o.extra ? { More: () => [] } : {}) } as never,
      evolve: { Done: (s: any) => s, ...(o.extra ? { Also: (s: any) => s } : {}) } as never,
    }) {}
    class P extends Domain.Policy("P", {
      from: A as never,
      key: A as never,
      on: (o.on ? [Done, Also] : [Done]) as never,
    }) {}
    return Domain.Model("M", { aggregates: [A], policies: [P] } as never);
  };

  it("stable: the same definitions built twice give the same hash, and list order does not matter", () => {
    expect(modelHashOf(make())).toBe(modelHashOf(make()));
    expect(modelHashOf(make({ flip: true }))).toBe(modelHashOf(make()));
    expect(modelHashOf(M.JobModel)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("a changed field type, command list or event list changes the hash", () => {
    const base = modelHashOf(make());
    for (const o of [{ text: true }, { extra: true }, { on: true }])
      expect(modelHashOf(make(o))).not.toBe(base);
  });

  const violation = async () => {
    const s = M.jobScenario({ rules: [M.JOB_ARMED] });
    const r = await run(s);
    return { s, v: r.violations.find((x) => x.rule === "JOB-ARMED")!, r };
  };

  it("every counterexample and the report carry the hash", async () => {
    const { r, v } = await violation();
    expect(v.trace.modelHash).toBe(modelHashOf(M.JobModel));
    expect(r.modelHash).toBe(v.trace.modelHash);
  });

  it("replay on a changed model refuses with a clear message; so does a trace with no hash", async () => {
    const { s, v } = await violation();
    const changed = { ...s, model: M.TwoModel };
    await expect(replay(changed, v.trace)).rejects.toThrow(
      /the model changed: .* Refusing to replay/,
    );
    await expect(replay(s, { ...v.trace, modelHash: undefined as never })).rejects.toThrow(
      /\(none\)/,
    );
    await expect(replay(s, v.trace)).resolves.toBeDefined();
  });

  it("a Story is refused on a changed model, and a generated fixture holds the hash and its guard", async () => {
    const s = M.jobScenario({ rules: [M.JOB_ARMED_TAIL] });
    const v = (await run(s)).violations.find((x) => x.rule === "JOB-ARMED")!;
    const bindings = {
      ...M.jobStoryBindings,
      modelGuard: (h: string) => `assertModelHash(JobModel, ${JSON.stringify(h)})`,
    };
    await expect(toStory({ ...s, model: M.TwoModel }, v, bindings)).rejects.toThrow(
      /the model changed/,
    );
    const out = (await toStory(s, v, bindings)) as { code: string };
    expect(out.code).toContain(`assertModelHash(JobModel, "${v.trace.modelHash}")`);
    expect(() => assertModelHash(M.JobModel, v.trace.modelHash)).not.toThrow();
    expect(() => assertModelHash(M.TwoModel, v.trace.modelHash, "this Story")).toThrow(
      /this Story was made on model hash/,
    );
  });
});

describe("honest fields on every run", () => {
  const check = (r: Awaited<ReturnType<typeof run>>) => {
    const json = JSON.parse(JSON.stringify(r));
    expect(json.proof).toBe(false);
    for (const k of [
      "scope",
      "effectsExecuted",
      "complete",
      "bounds",
      "limits",
      "modelHash",
      "ruleVerdicts",
      "vacuous",
    ])
      expect(json).toHaveProperty(k);
    expect(json.effectsExecuted.external).toBe(false);
    expect(Array.isArray(json.scope.actors)).toBe(true);
  };

  it("BFS exhausted: complete, and still proof false", async () => {
    const r = await run(M.twoBits);
    check(r);
    expect(r.complete).toBe(true);
    expect(r.effectsExecuted.fakes).toEqual(["g"]);
    expect(r.scope.actors).toEqual(["a", "b"]);
    expect(r.limits).toMatchObject({ depth: 10 });
  });

  it("WithinDepth, swarm, a cap and an engine error: complete false", async () => {
    const within = await run({ ...M.depthGraph, bounds: { depth: 2 } });
    check(within);
    expect(within.complete).toBe(false);
    const swarm = await run(M.twoBits, {
      search: { kind: "swarm", seeds: [1], walks: 2, depth: 3 },
    });
    check(swarm);
    expect(swarm.complete).toBe(false);
    const cap = await run(M.jobScenario({ ids: ["J1", "J2"] }), { limits: { states: 3 } });
    check(cap);
    expect(cap.complete).toBe(false);
    const err = await run(M.asyncActor);
    check(err);
    expect(err.complete).toBe(false);
  });

  it("a refused setup still reports every field", async () => {
    const r = await run({ ...M.twoBits, host: { views: { Nope: "abstract" } } });
    check(r);
    expect(r.complete).toBe(false);
  });

  it("an abstract view is listed as not run", async () => {
    const { spiScenario } = await import("./Spi.model.ts");
    const r = await run(spiScenario({ views: "abstract" }));
    expect(r.effectsExecuted.notRun.join()).toMatch(/view SrcCount \(abstract\)/);
  });
});
