import * as Domain from "@alchemy.run/domain";
import {
  fakeState,
  modelHashOf,
  run,
  send,
  spend,
  toStory,
  UnsupportedStoryTrace,
  type Rule,
  type Scenario,
} from "@alchemy.run/domain/Explore";
import { digest, digestHex } from "@alchemy.run/domain/internal/explore/Canonical";
import { startPool } from "@alchemy.run/domain/internal/explore/Workers";
/** Regressions: each test holds a false verdict or a hang the engine once had. */
import { describe, expect, it } from "@alchemy.run/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as M from "./Models.ts";

describe("every search checks the state", { tags: ["unit", "local"] }, () => {
  it("the swarm refuses a Date in fake state", async () => {
    const r = await run(M.dateActor, { search: { kind: "swarm", seeds: [1], walks: 1, depth: 2 } });
    expect(r.coverage).toEqual({ _tag: "CutOff", reason: "engine-error" });
    expect(r.engineErrors.map((e) => e.kind)).toContain("NonJsonState");
  });
});

describe("a witness must be the state the search saw", { tags: ["unit", "local"] }, () => {
  let hidden = 0;
  const counter: Scenario = {
    ...M.twoBits,
    name: "hiddenCounter",
    actors: [
      {
        key: "n",
        enabled: (s) => s.fake("g").n === undefined,
        run: () => Effect.sync(() => void (fakeState<any>("g").n = ++hidden)),
      },
    ],
    rules: [
      { id: "N", kind: "state", check: (s) => (s.fake("g").n ? `n=${s.fake("g").n}` : undefined) },
    ],
  };
  it("a fresh replay that reaches another state is an engine error, not a clean witness", async () => {
    const r = await run(counter, { freshEvery: 0 });
    expect(r.engineErrors.map((e) => e.kind)).toContain("HiddenState");
    expect(r.complete).toBe(false);
  });
});

describe("a Story is proven on the real runner", { tags: ["unit", "local"] }, () => {
  const PENDING: Rule = {
    id: "PENDING",
    kind: "state",
    check: (s) => (s.work().length > 0 ? "work is pending" : undefined),
    storyTail: () => ({ code: [], steps: [] }),
  };
  it("a real break gives a Story, proven RED on the rule", async () => {
    const s = M.jobScenario({ rules: [M.JOB_ARMED_TAIL] });
    const r = await run(s);
    const out = await toStory(
      s,
      r.violations.find((v) => v.rule === "JOB-ARMED")!,
      M.jobStoryBindings,
    );
    expect(out).not.toBeInstanceOf(UnsupportedStoryTrace);
    expect((out as { code: string }).code).toContain("new Freeze");
  });
  it("a break that the Story schedule settles away is refused (no false confirmation)", async () => {
    const s = M.jobScenario({ rules: [PENDING] });
    const r = await run(s);
    expect(
      await toStory(
        s,
        r.violations.find((v) => v.rule === "PENDING")!,
        M.jobStoryBindings,
      ),
    ).toBeInstanceOf(UnsupportedStoryTrace);
  });
  it("a rule with no tail is refused", async () => {
    const s = M.jobScenario({ rules: [M.JOB_ARMED] });
    const r = await run(s);
    const out = await toStory(
      s,
      r.violations.find((v) => v.rule === "JOB-ARMED")!,
      M.jobStoryBindings,
    );
    expect((out as UnsupportedStoryTrace).reason).toMatch(/no Story tail/);
  });
});

describe("a batched projection is not queued", { tags: ["unit", "local"] }, () => {
  it("queued + batch option is refused at setup", async () => {
    class Rows extends Domain.Projection("Rows", { from: [M.Src], key: M.Src, on: [M.Go] }) {}
    const Live = Rows.toLayer(Effect.succeed(Effect.fn(function* () {})), { batch: { size: 10 } });
    class Model extends Domain.Model("Batched", { aggregates: [M.Src], projections: [Rows] }) {}
    const r = await run({
      ...M.twoBits,
      name: "batched",
      model: Model,
      layer: Model.layer(Live),
    });
    expect(r.engineErrors.map((e) => e.detail).join()).toMatch(/batch/);
    expect(r.complete).toBe(false);
  });
});

describe("failure paths and limits", { tags: ["unit", "local"] }, () => {
  it("a refused build closes its scope", async () => {
    class Rows extends Domain.Projection("Rows", { from: [M.Src], key: M.Src, on: [M.Go] }) {}
    let closed = 0;
    const Live = Layer.mergeAll(
      Rows.toLayer(Effect.succeed(Effect.fn(function* () {})), { batch: { size: 10 } }),
      Layer.effectDiscard(Effect.addFinalizer(() => Effect.sync(() => void closed++))),
    );
    class Model extends Domain.Model("BuiltThenRefused", {
      aggregates: [M.Src],
      projections: [Rows],
    }) {}
    const r = await run({ ...M.twoBits, name: "refused", model: Model, layer: Model.layer(Live) });
    expect(r.engineErrors.length).toBe(1);
    expect(closed).toBe(1);
  });

  class FakeWorker {
    static made: Array<FakeWorker> = [];
    readonly handlers = new Map<string, (value: any) => void>();
    terminated = false;
    constructor(_url: string | URL) {
      FakeWorker.made.push(this);
    }
    on(event: string, f: (value: any) => void) {
      this.handlers.set(event, f);
    }
    terminate() {
      this.terminated = true;
    }
    postMessage(m: any) {
      if (m.t === "init")
        this.handlers.get("message")?.({
          t: "ready",
          fingerprint: FakeWorker.made.indexOf(this) === 0 ? "ok" : "other",
        });
      if (m.t === "expand") this.handlers.get("error")?.({ message: "boom" });
    }
  }
  const spec = (count: number) => ({ count, url: "x", init: {}, worker: FakeWorker });
  const opts = { exact: false, k: 3, maxDepth: 3 };

  it("a refused init terminates every worker", async () => {
    FakeWorker.made = [];
    await expect(startPool(spec(2), opts, "ok")).rejects.toThrow(/another config/);
    expect(FakeWorker.made.every((w) => w.terminated)).toBe(true);
  });
  it("a failed worker rejects the calls that wait for a worker", async () => {
    FakeWorker.made = [];
    const pool = await startPool(spec(1), opts, "ok");
    const calls = [pool.expand([], new Map(), []), pool.expand([], new Map(), [])];
    expect((await Promise.allSettled(calls)).map((c) => c.status)).toEqual([
      "rejected",
      "rejected",
    ]);
    pool.stop();
  });
  it("the swarm stops at its limits", async () => {
    const r = await run(M.jobScenario({ ids: ["J1", "J2"] }), {
      search: { kind: "swarm", seeds: [1], walks: 1e9, depth: 12 },
      limits: { elapsedMillis: 50 },
    });
    expect(r.coverage._tag).toBe("Sampled");
    expect(r.limits).toMatchObject({ elapsedMillis: 50 });
  });
});

describe("identity", { tags: ["unit", "local"] }, () => {
  it("one digest everywhere: truncated SHA-256", () => {
    expect(digestHex(digest("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223");
    expect(digestHex(digest("héllo ✓"))).toHaveLength(32);
  });
  it("a changed rejection schema changes the hash", () => {
    const make = (why: Schema.Top) => {
      class No extends Domain.Rejection("No", { why }) {}
      class E extends Domain.Event("E", {}) {}
      class C extends Domain.Command("C", {
        target: Schema.String,
        input: {},
        events: [E],
        rejects: [No],
      }) {}
      class A extends Domain.Aggregate("A", {
        id: Schema.String,
        state: Schema.Struct({}),
        initial: {},
        commands: [C],
        decide: { C: () => [] },
        evolve: { E: (s: any) => s },
      } as never) {}
      return Domain.Model("M", { aggregates: [A] } as never);
    };
    expect(modelHashOf(make(Schema.Number))).not.toBe(modelHashOf(make(Schema.String)));
  });
  it("the report names digest identity as probabilistic", async () => {
    const r = await run(M.twoBits);
    expect(r.identity).toMatchObject({
      mode: "digest",
      algorithm: "sha256-128/1",
      probabilistic: true,
    });
    expect((await run(M.twoBits, { identity: "exact" })).identity).toMatchObject({
      mode: "exact",
      probabilistic: false,
    });
  });
});

describe("honest text", { tags: ["unit", "local"] }, () => {
  it("effectsExecuted says it is a declaration, and a refused setup ran nothing", async () => {
    expect((await run(M.twoBits)).effectsExecuted).toMatchObject({
      basis: "declared by the scenario, not measured",
    });
    const refused = await run({ ...M.twoBits, host: { views: { Nope: "abstract" } } });
    expect(refused.effectsExecuted.real).toEqual([]);
  });
  it("the host profile names the last-item limit of redelivery", async () => {
    expect(JSON.stringify((await run(M.twoBits)).hostProfile)).toMatch(/last delivered item/);
  });
  it("only bfs and swarm run", async () => {
    await expect(run(M.twoBits, { search: { kind: "dfs" } } as never)).rejects.toThrow(/search/);
  });
});
