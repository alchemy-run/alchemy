import * as TwoPhase from "@alchemy.run/domain/TwoPhase";
import { describe, expect, it } from "@alchemy.run/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { check, conform, type Observation } from "everystate";

// `packages/domain/spec/TwoPhase.tla` models the commit of a decision across
// instances. Two things are held here: that the model keeps its promises in
// every order of steps and failures, and that the real `finish` and `deliver`
// take only steps the model allows.

const read = Effect.fn(function* (name: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* path.fromFileUrl(new URL("../../../domain/spec/", import.meta.url));
  return yield* fs.readFileString(path.join(dir, name));
});

const spec = Effect.all({ tla: read("TwoPhase.tla"), cfg: read("TwoPhase.cfg") }).pipe(
  Effect.provide(NodeServices.layer),
  Effect.orDie,
);

const checked = (tla: string, cfg: string) =>
  Effect.sync(() => check({ root: "TwoPhase", modules: { TwoPhase: tla }, config: cfg }).result);

/** A step of the spec, as the code that takes it reports it. */
type Step = (action: string, ...params: ReadonlyArray<string>) => void;

interface Faults {
  /** Calls that do not arrive, as `prepare:o2` or `deliver:o1`: each fails once. */
  readonly unreachable?: ReadonlyArray<string>;
  /** A broken instance: it holds an intent though it changed since it was read. */
  readonly ignoresVersion?: boolean;
}

/**
 * The storage of one attempt, as `TwoPhase.Primary` and `TwoPhase.Participant`
 * say each call behaves, with every call noted as a step of the spec.
 */
const world = (faults: Faults = {}) => {
  const others = ["o1", "o2"];
  const writers = new Set(["o1"]);
  const txId = "tx-1";
  const store = {
    pIntent: true,
    pRec: "none" as "none" | TwoPhase.Outcome,
    waiting: [...others],
    pApplied: false,
    pAborted: false,
    oIntent: { o1: false, o2: false } as Record<string, boolean>,
    oApplied: { o1: false, o2: false } as Record<string, boolean>,
    oVersion: { o1: 0, o2: 0 } as Record<string, number>,
  };
  store.waiting = [];
  const left = new Set(faults.unreachable ?? []);
  const trace: Array<Observation> = [];
  const snapshot = () => ({
    ...store,
    waiting: [...store.waiting],
    oIntent: { ...store.oIntent },
    oApplied: { ...store.oApplied },
    oVersion: { ...store.oVersion },
  });
  trace.push({ state: snapshot() });
  const step: Step = (action, ...params) => {
    trace.push({ action, params: [...params], state: snapshot() });
  };
  const plan: TwoPhase.Plan = {
    txId,
    primary: { aggregate: "Account", id: "p" },
    version: 0,
    events: [{ _tag: "Sent" }],
    commandId: "c-1",
    now: 0,
    correlationId: "c-1",
    receipt: { commits: [], events: [], reply: null },
    others: others.map((id) => ({
      aggregate: "Account",
      id,
      version: 0,
      events: writers.has(id) ? [{ _tag: "Received" }] : [],
    })),
  };
  /** Whether a call fails this once. */
  const fails = (call: string) => left.delete(call);
  // Each call gives way first, so two runs take their steps in turn.
  const turn = Effect.yieldNow;
  const apply = (id: string) => {
    if (!store.oIntent[id]) return;
    store.oIntent[id] = false;
    store.oApplied[id] = true;
    if (writers.has(id)) store.oVersion[id] = 1;
  };
  const drive = (driver: string): TwoPhase.Drive => ({
    primary: {
      read: () => Effect.succeed({ _tag: "Busy" }),
      hold: () => Effect.succeed({ _tag: "Busy" }),
      commit: () =>
        turn.pipe(
          Effect.map(() => {
            const held = store.pIntent;
            if (held) {
              store.pIntent = false;
              store.pApplied = true;
              store.pRec = "Committed";
              store.waiting = [...others];
            }
            step("PrimaryCommit", driver);
            return held || store.pRec === "Committed" ? ("Committed" as const) : ("Gone" as const);
          }),
        ),
      abort: () =>
        turn.pipe(
          Effect.map((): TwoPhase.Outcome => {
            const held = store.pIntent;
            if (held) {
              store.pIntent = false;
              store.pAborted = true;
              store.pRec = "Aborted";
              store.waiting = [...others];
            }
            step("PrimaryAbort", driver);
            return held || store.pRec === "none" ? "Aborted" : store.pRec;
          }),
        ),
      delivered: (_, reached) =>
        turn.pipe(
          Effect.map(() => {
            if (store.pRec !== "none") {
              store.waiting = store.waiting.filter(
                (id) => !reached.some((address) => address.id === id),
              );
              if (store.waiting.length === 0) store.pRec = "none";
            }
            step("Delivered", driver);
          }),
        ),
    },
    participant: ({ id }) => {
      const told = (outcome: TwoPhase.Outcome) =>
        turn.pipe(
          Effect.flatMap(() => {
            if (fails(`deliver:${id}`)) {
              step("DeliverFails", driver, id);
              return Effect.fail(new TwoPhase.Unreachable({ cause: "lost" }));
            }
            if (outcome === "Committed") apply(id);
            else store.oIntent[id] = false;
            step("Deliver", driver, id);
            return Effect.void;
          }),
        );
      return {
        read: Effect.succeed({ _tag: "Busy" }),
        prepare: () =>
          turn.pipe(
            Effect.flatMap(() => {
              if (fails(`prepare:${id}`)) {
                step("PrepareFails", driver, id);
                return Effect.fail(new TwoPhase.Unreachable({ cause: "lost" }));
              }
              const prepared =
                store.oIntent[id] || store.oVersion[id] === 0 || faults.ignoresVersion === true;
              if (prepared) store.oIntent[id] = true;
              step("Prepare", driver, id);
              return Effect.succeed<TwoPhase.PrepareResult>(
                prepared ? { _tag: "Prepared" } : { _tag: "Conflict" },
              );
            }),
          ),
        commit: () => told("Committed"),
        abort: () => told("Aborted"),
      };
    },
  });
  /** The primary's wake-up, as its host runs it: the plan it still holds, then any outcome not yet received. */
  const wake = Effect.gen(function* () {
    if (store.pIntent) {
      step("Wake", "wake");
      yield* TwoPhase.finish(drive("wake"), plan);
    }
    if (store.pRec !== "none") {
      step("Wake", "wake");
      yield* TwoPhase.deliver(
        drive("wake"),
        txId,
        store.pRec,
        store.waiting.map((id) => ({ aggregate: "Account", id })),
      );
    }
  });
  /** Another command changes an instance nothing holds. */
  const changes = (id: string) => {
    store.oVersion[id] = 1;
    step("Changes", id);
  };
  return { store, trace, plan, drive, wake, changes };
};

const conforms = (trace: ReadonlyArray<Observation>) =>
  Effect.map(spec, ({ tla, cfg }) =>
    conform({ root: "TwoPhase", modules: { TwoPhase: tla }, config: cfg, trace: [...trace] }),
  );

describe("Domain TwoPhase against its spec", { tags: ["unit", "local"] }, () => {
  it.effect("the model keeps every promise, in every order of steps and failures", () =>
    Effect.gen(function* () {
      const { tla, cfg } = yield* spec;
      const result = yield* checked(tla, cfg);
      expect(result).toMatchObject({ status: "ok", distinct: 12735 });
    }),
  );

  it.effect("a primary that keeps no outcome loses an instance's part", () =>
    Effect.gen(function* () {
      const { tla, cfg } = yield* spec;
      const result = yield* checked(
        tla,
        cfg.replace("RecordsOutcome = TRUE", "RecordsOutcome = FALSE"),
      );
      expect(result).toMatchObject({ status: "invariant", name: "NothingLost" });
    }),
  );

  it.effect("an abort that forgets the commit tells the others it aborted", () =>
    Effect.gen(function* () {
      const { tla, cfg } = yield* spec;
      const result = yield* checked(
        tla,
        cfg.replace("AbortChecksCommit = TRUE", "AbortChecksCommit = FALSE"),
      );
      expect(result).toMatchObject({ status: "invariant", name: "LateAbortIsHarmless" });
    }),
  );

  it.effect("without a wake-up, a run that dies leaves the attempt unsettled", () =>
    Effect.gen(function* () {
      const { tla, cfg } = yield* spec;
      const result = yield* checked(tla, cfg.replace("Drivers = {call, wake}", "Drivers = {call}"));
      expect(result).toMatchObject({ status: "liveness" });
    }),
  );

  it.effect("finish commits, and every step is one the model allows", () =>
    Effect.gen(function* () {
      const { store, trace, plan, drive } = world();
      expect(yield* TwoPhase.finish(drive("call"), plan)).toBe("Committed");
      expect(store.oApplied).toEqual({ o1: true, o2: true });
      expect(yield* conforms(trace)).toMatchObject({ status: "conforms", matched: 7 });
    }),
  );

  it.effect("finish aborts when an instance changed, as the model says", () =>
    Effect.gen(function* () {
      const { store, trace, plan, drive, changes } = world();
      changes("o2");
      expect(yield* TwoPhase.finish(drive("call"), plan)).toBe("Aborted");
      expect(store).toMatchObject({ pAborted: true, oApplied: { o1: false, o2: false } });
      expect(yield* conforms(trace)).toMatchObject({ status: "conforms" });
    }),
  );

  it.effect("an instance that was not reached is told by the wake-up", () =>
    Effect.gen(function* () {
      const { store, trace, plan, drive, wake } = world({ unreachable: ["deliver:o2"] });
      expect(yield* TwoPhase.finish(drive("call"), plan)).toBe("Committed");
      expect(store).toMatchObject({ pRec: "Committed", waiting: ["o2"] });
      yield* wake;
      expect(store).toMatchObject({ pRec: "none", oApplied: { o1: true, o2: true } });
      expect(yield* conforms(trace)).toMatchObject({ status: "conforms" });
    }),
  );

  it.effect("a wake-up that overlaps the call it finishes takes only steps the model allows", () =>
    Effect.gen(function* () {
      const { store, trace, plan, drive, wake } = world({ unreachable: ["prepare:o2"] });
      const [first] = yield* Effect.all([TwoPhase.finish(drive("call"), plan), wake], {
        concurrency: "unbounded",
      });
      // One run could not reach an instance and aborted; the other finds the attempt gone.
      expect(first).toBe("Aborted");
      expect(store).toMatchObject({
        pIntent: false,
        pRec: "none",
        oIntent: { o1: false, o2: false },
        oApplied: { o1: false, o2: false },
      });
      expect(yield* conforms(trace)).toMatchObject({ status: "conforms" });
    }),
  );

  it.effect("a run the model does not allow is told apart", () =>
    Effect.gen(function* () {
      // An instance that holds an intent though it changed: the model has it refuse.
      const { trace, plan, drive, changes } = world({ ignoresVersion: true });
      changes("o2");
      yield* TwoPhase.finish(drive("call"), plan);
      const result = yield* conforms(trace);
      expect(result.status).toBe("mismatch");
      expect(result.failed?.observation).toMatchObject({
        action: "Prepare",
        params: ["call", "o2"],
      });
    }),
  );
});
