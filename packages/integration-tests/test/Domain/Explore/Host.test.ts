import { run, toCode, fakeState, send } from "@alchemy.run/domain/Explore";
import { canonical, digest, digestHex } from "@alchemy.run/domain/internal/explore/Canonical";
import {
  checkSetup,
  enabled,
  freshWorld,
  identityOf,
} from "@alchemy.run/domain/internal/explore/Engine";
import { explorePlatform, Rt, type World } from "@alchemy.run/domain/internal/explore/Host";
/**
 * Host fidelity: full state identity, full receipts, keyed policy order,
 * projection positions and failures, views.
 */
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as M from "./Models.ts";
import { spiScenario } from "./Spi.model.ts";

const hex = (w: World) => digestHex(digest(canonical(identityOf(w))));

describe("state identity: every field that changes later behaviour is in the hash", () => {
  const base = (): World => ({
    ...freshWorld(M.jobScenario()),
    aggs: {
      Job: {
        J1: {
          state: { a: 1 },
          version: 1,
          receipts: {
            c1: {
              _tag: "Accepted",
              receipt: { stream: "Job/J1", version: 1, events: [{ _tag: "E" }], reply: { n: 1 } },
            },
          },
          cancelled: {},
          armedBy: {},
        },
      },
    },
    work: {
      "policy|P|J1": [
        {
          d: {
            target: { kind: "policy", name: "P" },
            key: "J1",
            source: "Job/J1",
            seq: 1,
            origin: "Job",
            tag: "E",
            event: { _tag: "E", x: 1 },
            envelope: { id: "J1", stream: "Job/J1", seq: 1, at: 0, commandId: "c1" },
          } as never,
          tries: 0,
        },
      ],
    },
    timers: {
      "Job/J1/t1": {
        agg: "Job",
        id: "J1",
        command: { _tag: "Fire", deadline: 1 },
        meta: { commandId: "t1", context: { who: "a" } },
        at: 5,
      },
    },
    views: {
      V: {
        J1: {
          snapshot: { state: { n: 1 }, version: 1, checkpoints: { "Job/J1": 1 }, seq: 0 },
          entries: [],
        },
      },
    },
    proj: {
      P: {
        J1: {
          next: 1,
          pending: [],
          intake: { "Job/J1": 1 },
          checkpoints: { "Job/J1": 1 },
          tries: 0,
          stuck: false,
        },
      },
    },
  });
  const edits: Array<[string, (w: any) => void]> = [
    ["receipt reply", (w) => (w.aggs.Job.J1.receipts.c1.receipt.reply.n = 2)],
    ["receipt events", (w) => (w.aggs.Job.J1.receipts.c1.receipt.events = [])],
    ["pending event body", (w) => (w.work["policy|P|J1"][0].d.event.x = 2)],
    ["pending envelope", (w) => (w.work["policy|P|J1"][0].d.envelope.commandId = "c9")],
    ["timer command", (w) => (w.timers["Job/J1/t1"].command.deadline = 2)],
    ["timer context", (w) => (w.timers["Job/J1/t1"].meta.context.who = "b")],
    ["view snapshot", (w) => (w.views.V.J1.snapshot.state.n = 2)],
    ["projection checkpoint", (w) => (w.proj.P.J1.checkpoints["Job/J1"] = 0)],
    [
      "cancel on a version-zero instance",
      (w) =>
        (w.aggs.Job.J2 = {
          state: null,
          version: 0,
          receipts: {},
          cancelled: { t: true },
          armedBy: {},
        }),
    ],
    [
      "dead-letter content",
      (w) =>
        (w.dead = [
          {
            kind: "policy",
            target: "P",
            key: "J1",
            tag: "E",
            source: "Job/J1",
            seq: 1,
            error: "x",
          },
        ]),
    ],
  ];
  for (const [name, edit] of edits)
    it(name, () => {
      const a = base();
      const b = base();
      edit(b);
      expect(hex(b)).not.toBe(hex(a));
    });

  it("the redelivery memory counts only while a redelivery can happen", () => {
    const a = { ...base(), budget: { redeliveries: 0 } };
    const b = { ...a, delivered: { x: { d: {} as never, tries: 0 } } };
    expect(hex(b)).toBe(hex(a));
    expect(hex({ ...b, budget: { redeliveries: 1 } })).not.toBe(
      hex({ ...a, budget: { redeliveries: 1 } }),
    );
  });
});

describe("SPI parity", () => {
  it("a duplicate command id answers the FULL receipt (events too)", async () => {
    const scenario = {
      ...M.twoSends(false),
      name: "dup",
      fakes: [{ name: "seen", initial: () => ({ first: -1, second: -1 }) }],
      actors: [
        {
          key: "twice",
          enabled: (s: any) => s.state("Src", "s") === undefined,
          run: (ctx: any) =>
            Effect.gen(function* () {
              const a: any = yield* send(ctx, M.Src, "s", new M.Start({}), {
                commandId: "same",
              });
              const b: any = yield* send(ctx, M.Src, "s", new M.Start({}), {
                commandId: "same",
              });
              const seen = fakeState<{ first: number; second: number }>("seen");
              seen.first = a.events.length;
              seen.second = b.events.length;
            }),
        },
      ],
      rules: [
        {
          id: "SEEN",
          kind: "state" as const,
          check: (s: any) =>
            s.fake("seen").first >= 0
              ? `${s.fake("seen").first}/${s.fake("seen").second}`
              : undefined,
        },
      ],
    };
    const r = await run(scenario);
    expect(r.violations.find((v) => v.rule === "SEEN")!.message).toBe("1/1");
  });

  it("policy work is ordered per key in receive order: two sources into one key give one runnable head", () => {
    const rt = new Rt({});
    rt.world = freshWorld(M.jobScenario());
    const platform = explorePlatform(rt);
    const store = Effect.runSync(
      platform.policy({} as never, { name: "P", run: () => Effect.void }),
    );
    const d = (source: string, seq: number) => ({
      target: { kind: "policy" as const, name: "P" },
      key: "K",
      source,
      seq,
      origin: "A",
      tag: "E",
      event: {},
      envelope: { id: "x", stream: source, seq, at: 0, commandId: `c${seq}` },
    });
    Effect.runSync(store.receive(d("A/1", 5)));
    Effect.runSync(store.receive(d("A/2", 1)));
    expect(rt.world.work["policy|P|K"]!.map((q) => q.d.source)).toEqual(["A/1", "A/2"]);
    const built = { rt, scenario: M.jobScenario(), abstractViews: new Set<string>() } as never;
    expect(
      enabled(built, rt.world)
        .filter((m) => m.kind === "run")
        .map((m) => m.key),
    ).toEqual(["run:policy|P|K"]);
  });

  it("projection positions are partition positions; a duplicate (source, seq) is dropped", () => {
    const rt = new Rt({});
    rt.world = freshWorld(M.jobScenario());
    const store = Effect.runSync(
      explorePlatform(rt).projection({} as never, {
        name: "Q",
        options: {},
        run: () => Effect.void,
      }),
    );
    const d = (source: string, seq: number) => ({
      target: { kind: "projection" as const, name: "Q" },
      key: "K",
      source,
      seq,
      origin: "A",
      tag: "E",
      event: {},
      envelope: { id: "x", stream: source, seq, at: 0, commandId: `c${seq}` },
    });
    Effect.runSync(store.receive(d("A/1", 5)));
    Effect.runSync(store.receive(d("A/2", 1)));
    Effect.runSync(store.receive(d("A/1", 5)));
    expect(rt.world.proj.Q!.K!.pending.map((a) => a.position)).toEqual([1, 2]);
    expect(rt.world.proj.Q!.K!.checkpoints).toEqual({});
  });

  it("a failed projection run keeps its input and its checkpoint; the retry applies it once", async () => {
    const r = await run(spiScenario({ fails: 1 }));
    expect(r.coverage._tag).toBe("Exhausted");
    expect(r.violations.map((v) => v.rule)).toEqual([]);
  });

  it("views run: queued views add states; inline and abstract views are named in the report", async () => {
    const queued = await run(spiScenario({}));
    const inline = await run(spiScenario({ views: "inline" }));
    const abstract = await run(spiScenario({ views: "abstract" }));
    expect(queued.states).toBeGreaterThan(inline.states);
    expect(inline.abstractions.join()).toMatch(/SrcCount: applied in the committing step/);
    expect(abstract.abstractions.join()).toMatch(/SrcCount: not run/);
  });

  it("an abstract view that feeds a consumer, a stream or a saga is refused at setup", () => {
    const view = { viewName: "V", definition: { from: [] } };
    const model = {
      definitions: {
        aggregates: [],
        views: [view],
        policies: [{ policyName: "P", definition: { from: view } }],
        projections: [],
        streams: [{}],
      },
      sagas: [{}],
    };
    const { errors } = checkSetup({
      ...M.twoBits,
      model,
      host: { views: { V: "abstract" } },
    } as never);
    expect(errors.join("\n")).toMatch(/policy P consumes the abstract view V/);
    expect(errors.join("\n")).toMatch(/stream/);
    expect(errors.join("\n")).toMatch(/saga/);
  });
});

describe("Story values", () => {
  it("a plain tagged object keeps its _tag", () => {
    expect(toCode({ _tag: "Set", value: 1 })).toBe('{ _tag: "Set", value: 1 }');
  });
  it("a class instance prints as its constructor", () => {
    expect(toCode(new M.Start({}))).toBe("new Start({  })");
  });
});
