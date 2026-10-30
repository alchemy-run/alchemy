/**
 * Bounded state exploration of a real Model on a data-only host. A
 * {@link Scenario} gives the model, the fakes, the actors, the rules and the
 * bounds. The engine runs the real `decide`, `evolve`, policies, views and
 * projections under every order of moves inside the bounds (BFS), or under
 * seeded random walks (swarm), and checks the rules after each step.
 *
 * ```typescript
 * import * as Explore from "@alchemy.run/domain/Explore";
 *
 * const report = await Explore.run(scenario);
 * for (const v of report.violations) console.log(v.rule, v.message, v.path);
 * ```
 *
 * Contract:
 * - no state-space reductions: BFS over the full state, or a seeded swarm;
 * - states are compared by a 128-bit digest (`identity: "digest"`, a
 *   probabilistic match) or by their canonical text (`identity: "exact"`);
 * - engine errors (async effects, `Clock.sleep`, hidden randomness, non-JSON
 *   state, replay divergence, hidden layer state) are never a clean result;
 * - coverage says what was shown: `Exhausted`, `WithinDepth`, `CutOff` or
 *   `Sampled`;
 * - every counterexample is a trace, replayed on a fresh build against the
 *   digests the search saw;
 * - `proof` is always false: a green run is a bounded search on fakes.
 *
 * See https://alchemy.run/domain/explore.
 */
import * as Effect from "effect/Effect";
import {
  rulesOf,
  build,
  checkSetup,
  type Built,
  type Rule,
  type Scenario,
} from "./internal/explore/Engine.ts";
import {
  EngineFault,
  ExploreError,
  UnsupportedStoryTrace,
  type EngineError,
} from "./internal/explore/Errors.ts";
import { assertModelHash, modelHashOf } from "./internal/explore/ModelHash.ts";
import {
  bfs,
  cpuNow,
  swarmSeed,
  type Coverage,
  type SearchResult,
  type SwarmHit,
  type SwarmOptions,
} from "./internal/explore/Search.ts";
import {
  toStory as renderStory,
  type StoryBindings,
  type StoryOut,
} from "./internal/explore/Story.ts";
import {
  checkTrace,
  fingerprintOf,
  replayChain,
  type Trace,
  type Violation,
} from "./internal/explore/Trace.ts";
import { startPool, type WorkerSpec } from "./internal/explore/Workers.ts";

/** How to walk the states: all of them inside the bounds, or seeded random walks. */
export type Search = { readonly kind: "bfs" } | ({ readonly kind: "swarm" } & SwarmOptions);

/** How one run searches and when it stops. */
export interface Options {
  /** Default: `bfs`. */
  readonly search?: Search;
  readonly limits?: {
    readonly states?: number;
    readonly elapsedMillis?: number;
    readonly memoryBytes?: number;
  };
  /** `digest` (128-bit, the bound in the report) or `exact` (canonical strings, collisions counted). */
  readonly identity?: "digest" | "exact";
  /** Checkpoint worlds every k levels (the BFS frontier holds no worlds). Default 3. */
  readonly checkpointEvery?: number;
  /** Frontier nodes in one batch. Default 128. */
  readonly batch?: number;
  /** Expand on worker threads. Without it, one thread does the work. */
  readonly workers?: WorkerSpec;
  /** Hidden-state check: replay a new state's chain on a second build every N states (0: off). Default 5000. */
  readonly freshEvery?: number;
  readonly progress?: (line: string) => void;
}

/** The search progress when a rule first broke. */
export interface FirstFound {
  readonly states: number;
  readonly ms: number;
}

/**
 * BROKEN: a counterexample exists. VACUOUS: the rule's trigger never fired, so
 * the run says nothing about it. HELD: no break in a run that closed its
 * bounds (or hit only the depth bound). NOT-FOUND: no break in a run that was
 * cut off or sampled.
 */
export type Verdict = "BROKEN" | "VACUOUS" | "HELD" | "NOT-FOUND";

/** What one run says about one rule. */
export interface RuleVerdict {
  readonly rule: string;
  readonly kind: Rule["kind"];
  readonly verdict: Verdict;
  /** The trigger the rule named, if any. */
  readonly trigger?: string;
  readonly witnessed: boolean;
}

/** What a run covers. */
export interface Scope {
  readonly model: { readonly hash: string; readonly members: ReadonlyArray<string> };
  readonly actors: ReadonlyArray<string>;
  readonly fakes: ReadonlyArray<string>;
  readonly search: string;
  readonly note: string;
}

/** What really ran, as the scenario declares it. */
export interface EffectsExecuted {
  /** This field states what the scenario declares; the engine cannot observe what a layer does. */
  readonly basis: "declared by the scenario, not measured";
  readonly external: false;
  readonly real: ReadonlyArray<string>;
  readonly fakes: ReadonlyArray<string>;
  readonly notRun: ReadonlyArray<string>;
}

/** The result of one run. Violations are data; a run with engine errors has `complete: false`. */
export interface Report {
  readonly scenario: string;
  readonly fingerprint: string;
  readonly search: string;
  readonly hostProfile: Record<string, unknown>;
  readonly abstractions: ReadonlyArray<string>;
  readonly bounds: Scenario["bounds"];
  readonly coverage: Coverage;
  readonly states: number;
  readonly transitions: number;
  readonly moveRuns: number;
  readonly depth: number;
  readonly ms: number;
  readonly cpuSec: number;
  readonly peakRssMb: number;
  readonly memory?: SearchResult["memory"];
  readonly identity?: SearchResult["identity"];
  /** What this run covers, and nothing outside it. */
  readonly scope: Scope;
  /** What really ran. `external: false`: no real system was touched. */
  readonly effectsExecuted: EffectsExecuted;
  /** The limits this run had. */
  readonly limits: Record<string, number>;
  /** The graph inside the bounds closed. Nothing about anything outside `scope`. */
  readonly complete: boolean;
  /** Always false: this is a bounded search on fakes, a green run is not a proof. */
  readonly proof: false;
  /** The hash of the model's definitions. */
  readonly modelHash: string;
  readonly rulesChecked: ReadonlyArray<string>;
  readonly ruleVerdicts: ReadonlyArray<RuleVerdict>;
  /** Rules that named a trigger the run never witnessed: not held, not tested. */
  readonly vacuous: ReadonlyArray<string>;
  readonly violations: ReadonlyArray<
    Violation & { readonly firstFound?: FirstFound; readonly swarm?: Omit<SwarmHit, "chain"> }
  >;
  readonly engineErrors: ReadonlyArray<EngineError>;
}

const REDELIVERY = "before-ack (redelivery of the last delivered item of a partition; budget)";

const hostProfileOf = (s: Scenario) => ({
  maxTries: s.host?.maxTries ?? 2,
  policyOrder:
    "one FIFO per (policy, key), in receive order (commit order): not Cluster transport order",
  faultPoints: s.host?.faultable
    ? ["before-commit (lost)", "after-commit (reply lost)", REDELIVERY]
    : [REDELIVERY],
  retry:
    "a failed run stays at the head of its partition; retries are immediate moves (no backoff time); after maxTries: dead letter",
  timers:
    "a due timer fires in any order; with none due the earliest fires (the clock jumps); `tick` moves the clock without a fire; a timer stays armed until its command commits",
  atomicity:
    "one actor run, one policy run, one view/projection run is one atomic step; host faults on sends give the crash points inside a run",
  receipts: "kept forever (no retention window)",
});

const membersOf = (s: Scenario): Array<string> => {
  const d = s.model.definitions as any;
  return [
    ...d.aggregates.map((a: any) => `aggregate ${a.aggregateName}`),
    ...d.policies.map((p: any) => `policy ${p.policyName}`),
    ...d.views.map((v: any) => `view ${v.viewName}`),
    ...d.projections.map((p: any) => `projection ${p.projectionName}`),
  ];
};

const effectsOf = (s: Scenario): EffectsExecuted => {
  const d = s.model.definitions as any;
  const views = s.host?.views ?? {};
  const off = d.views.map((v: any) => v.viewName).filter((n: string) => views[n] === "abstract");
  return {
    basis: "declared by the scenario, not measured",
    external: false,
    real: [
      "aggregate decide and evolve (the real kernel)",
      ...(d.policies.length > 0 ? ["policy handlers"] : []),
      ...(d.projections.length > 0 ? ["projection handlers"] : []),
      ...(d.views.length > off.length ? ["view folds"] : []),
    ],
    fakes: s.fakes.map((f) => f.name),
    notRun: [
      ...off.map((n: string) => `view ${n} (abstract)`),
      "Api handlers and middleware outside the actors",
      "live reads, streams, sagas",
      "real stores, queues, clocks and external systems",
    ],
  };
};

const verdictsOf = (
  scenario: Scenario,
  coverage: Coverage,
  violations: ReadonlyArray<{ readonly rule: string }>,
  witnessed: ReadonlySet<string>,
): Array<RuleVerdict> => {
  const broken = new Set(violations.map((v) => v.rule));
  const closed = coverage._tag === "Exhausted" || coverage._tag === "WithinDepth";
  return rulesOf(scenario).map((r) => {
    const seen = witnessed.has(r.id);
    const verdict: Verdict = broken.has(r.id)
      ? "BROKEN"
      : r.reachable && !seen
        ? "VACUOUS"
        : closed
          ? "HELD"
          : "NOT-FOUND";
    return {
      rule: r.id,
      kind: r.kind,
      verdict,
      ...(r.reachable ? { trigger: r.reachable.text } : {}),
      witnessed: seen,
    };
  });
};

/** Replay a found chain on another build; each step must reach the digest the search saw. */
const toViolation = (
  b: Built,
  rule: string,
  message: string,
  chain: ReadonlyArray<{ move: string; script: any; digest: string }>,
  fingerprint: string,
): Violation => {
  const r = replayChain(b, chain);
  r.steps.forEach((s, i) => {
    if (s.digest !== chain[i]!.digest)
      throw new EngineFault(
        "HiddenState",
        `${rule}, step ${i + 1} (${s.label}): a fresh build reached ${s.digest}, the search saw ${chain[i]!.digest}`,
      );
  });
  const again = r.breaks.find(([id]) => id === rule);
  if (!again)
    throw new EngineFault("HiddenState", `a fresh build does not break ${rule} on the found path`);
  if (again[1] !== message)
    throw new EngineFault(
      "HiddenState",
      `${rule}: a fresh build says "${again[1]}", the search said "${message}"`,
    );
  const trace: Trace = {
    version: 3,
    scenario: b.scenario.name,
    modelHash: modelHashOf(b.scenario.model),
    fingerprint,
    rule,
    steps: r.steps,
  };
  return { rule, message, trace, path: r.path, world: r.world };
};

/** Explore a scenario. The Promise form (the Effect form is `exploreEffect`). */
export const run = async (scenario: Scenario, options: Options = {}): Promise<Report> => {
  const search = options.search ?? { kind: "bfs" };
  if (search.kind !== "bfs" && search.kind !== "swarm")
    throw new EngineFault(
      "Unsupported",
      `search ${(search as { kind: string }).kind}: only bfs and swarm`,
    );
  const setup = checkSetup(scenario);
  const fingerprint = fingerprintOf(scenario);
  const modelHash = modelHashOf(scenario.model);
  const searchText =
    search.kind === "swarm"
      ? `swarm(seeds ${search.seeds.join(",")}, ${search.walks !== undefined ? `${search.walks} walks` : `${search.timeMillis} ms`}/seed, depth ${search.depth})`
      : search.kind;
  const base = {
    scenario: scenario.name,
    fingerprint,
    search: searchText,
    hostProfile: hostProfileOf(scenario),
    abstractions: setup.abstractions,
    bounds: scenario.bounds,
    rulesChecked: rulesOf(scenario).map((r) => r.id),
    modelHash,
    scope: {
      model: { hash: modelHash, members: membersOf(scenario) },
      actors: scenario.actors.map((a) => a.key),
      fakes: scenario.fakes.map((f) => f.name),
      search: searchText,
      note: "only these actors, fakes, bounds and limits; a green run says nothing outside them",
    },
    effectsExecuted: effectsOf(scenario),
    proof: false,
  } as const;
  const finish = (
    r: Omit<Report, keyof typeof base | "complete" | "ruleVerdicts" | "vacuous"> &
      Partial<Pick<Report, "effectsExecuted">>,
    witnessed: ReadonlyArray<string>,
  ): Report => {
    const ruleVerdicts = verdictsOf(scenario, r.coverage, r.violations, new Set(witnessed));
    return {
      ...base,
      ...r,
      complete: r.coverage._tag === "Exhausted" && r.engineErrors.length === 0,
      ruleVerdicts,
      vacuous: ruleVerdicts.filter((v) => v.verdict === "VACUOUS").map((v) => v.rule),
    };
  };
  let b: Built;
  try {
    b = await build(scenario);
  } catch (e) {
    const f = e instanceof EngineFault ? e : new EngineFault("Unsupported", String(e));
    return finish(
      {
        effectsExecuted: { ...effectsOf(scenario), real: [] },
        coverage: { _tag: "CutOff", reason: "engine-error" },
        states: 0,
        transitions: 0,
        moveRuns: 0,
        depth: 0,
        ms: 0,
        cpuSec: 0,
        peakRssMb: 0,
        limits: {},
        violations: [],
        engineErrors: [{ kind: f.kind, detail: f.detail }],
      },
      [],
    );
  }
  const builds = [b];
  const another = async () => {
    const next = await build(scenario);
    builds.push(next);
    return next;
  };
  try {
    const fresh = await another();
    const shadow = await another();
    if (search.kind === "swarm") {
      const t0 = performance.now();
      const c0 = cpuNow();
      const pool = options.workers
        ? await startPool(
            options.workers,
            { exact: false, k: 3, maxDepth: scenario.bounds.depth },
            fingerprint,
          )
        : undefined;
      const limits = {
        elapsedMillis: options.limits?.elapsedMillis ?? 600_000,
        memoryBytes: options.limits?.memoryBytes ?? 16e9,
        states: options.limits?.states ?? Number.MAX_SAFE_INTEGER,
      };
      let outs: Array<ReturnType<typeof swarmSeed>>;
      try {
        outs = pool
          ? await Promise.all(search.seeds.map((seed) => pool.swarm(seed, search, limits)))
          : search.seeds.map((seed) => swarmSeed(b, seed, search, limits));
      } finally {
        pool?.stop();
      }
      const engineErrors = outs.flatMap((o) => o.engine);
      const best = new Map<string, SwarmHit>();
      for (const o of outs)
        for (const h of o.hits)
          if (!best.has(h.rule) || best.get(h.rule)!.chain.length > h.chain.length)
            best.set(h.rule, h);
      const violations: Array<Report["violations"][number]> = [];
      for (const h of best.values()) {
        const { chain, ...meta } = h;
        try {
          violations.push({
            ...toViolation(fresh, h.rule, h.message, chain, fingerprint),
            swarm: meta,
          });
        } catch (e) {
          engineErrors.push({
            kind: e instanceof EngineFault ? e.kind : "HiddenState",
            detail: `${h.rule}: ${(e as Error).message}`,
          });
        }
      }
      return finish(
        {
          limits: {
            depth: search.depth,
            elapsedMillis: limits.elapsedMillis,
            memoryBytes: limits.memoryBytes,
            ...(search.walks !== undefined ? { walksPerSeed: search.walks } : {}),
            ...(search.timeMillis !== undefined ? { millisPerSeed: search.timeMillis } : {}),
          },
          coverage:
            engineErrors.length > 0
              ? { _tag: "CutOff", reason: "engine-error" }
              : {
                  _tag: "Sampled",
                  seeds: search.seeds,
                  walks: outs.reduce((s, o) => s + o.walks, 0),
                },
          states: 0,
          transitions: outs.reduce((s, o) => s + o.runs, 0),
          moveRuns: outs.reduce((s, o) => s + o.runs, 0),
          depth: search.depth,
          ms: Math.round(performance.now() - t0),
          cpuSec: Math.round(cpuNow() - c0),
          peakRssMb: Math.round(process.memoryUsage().rss / 1e6),
          violations,
          engineErrors,
        },
        outs.flatMap((o) => o.witnessed),
      );
    }
    const opts = {
      exact: options.identity === "exact",
      k: options.checkpointEvery ?? 3,
      maxDepth: scenario.bounds.depth,
      states: options.limits?.states ?? 5_000_000,
      elapsedMillis: options.limits?.elapsedMillis ?? 600_000,
      memoryBytes: options.limits?.memoryBytes ?? 16e9,
      batch: options.batch ?? 128,
      freshEvery: options.freshEvery ?? 5000,
      progress: options.progress,
    };
    let result: SearchResult;
    {
      const pool =
        options.workers && options.workers.count > 1
          ? await startPool(
              options.workers,
              { exact: opts.exact, k: opts.k, maxDepth: opts.maxDepth },
              fingerprint,
            )
          : undefined;
      try {
        result = await bfs(b, shadow, opts, pool);
      } finally {
        pool?.stop();
      }
    }
    const engineErrors = [...result.engine];
    const violations: Array<Report["violations"][number]> = [];
    for (const f of result.found) {
      try {
        violations.push({
          ...toViolation(fresh, f.rule, f.message, f.chain, fingerprint),
          firstFound: { states: f.states, ms: f.ms },
        });
      } catch (e) {
        engineErrors.push({
          kind: e instanceof EngineFault ? e.kind : "HiddenState",
          detail: `${f.rule}: ${(e as Error).message}`,
        });
      }
    }
    return finish(
      {
        limits: {
          states: opts.states,
          elapsedMillis: opts.elapsedMillis,
          memoryBytes: opts.memoryBytes,
          depth: opts.maxDepth,
        },
        coverage:
          engineErrors.length > 0 && result.coverage._tag !== "CutOff"
            ? { _tag: "CutOff", reason: "engine-error" }
            : result.coverage,
        states: result.states,
        transitions: result.transitions,
        moveRuns: result.moveRuns,
        depth: result.depth,
        ms: result.ms,
        cpuSec: result.cpuSec,
        peakRssMb: result.peakRssMb,
        memory: result.memory,
        identity: result.identity,
        violations,
        engineErrors,
      },
      result.witnessed,
    );
  } finally {
    await Promise.all(builds.map((x) => x.close()));
  }
};

/** The Effect form: an engine error is the typed failure; violations are data in the report. */
export const explore = (
  scenario: Scenario,
  options: Options = {},
): Effect.Effect<Report, ExploreError> =>
  Effect.tryPromise({
    try: () => run(scenario, options),
    catch: (e) => new ExploreError({ errors: [{ kind: "Unsupported", detail: String(e) }] }),
  }).pipe(
    Effect.flatMap((r) =>
      r.engineErrors.length > 0
        ? Effect.fail(new ExploreError({ errors: r.engineErrors }))
        : Effect.succeed(r),
    ),
  );

/** Replay a trace on a fresh build: every digest and the rule failure must match. */
export const replay = async (scenario: Scenario, trace: Trace) => {
  assertModelHash(scenario.model, trace.modelHash, `the trace of ${trace.rule}`);
  if (trace.fingerprint !== fingerprintOf(scenario))
    throw new EngineFault(
      "ReplayDiverged",
      "the trace was made from another scenario (fingerprint differs)",
    );
  const b = await build(scenario);
  try {
    return checkTrace(b, trace);
  } finally {
    await b.close();
  }
};

/** A Story for a counterexample, or `UnsupportedStoryTrace` when the Story host cannot reach it. */
export const toStory = async (
  scenario: Scenario,
  v: Violation,
  bindings: StoryBindings,
): Promise<StoryOut | UnsupportedStoryTrace> => {
  assertModelHash(scenario.model, v.trace.modelHash, `the trace of ${v.rule}`);
  const b = await build(scenario);
  try {
    const rule = b.rules.find((r) => r.id === v.rule);
    if (!rule) return new UnsupportedStoryTrace({ reason: `no rule ${v.rule}` });
    return await renderStory(b, v.trace, rule, v.message, bindings);
  } finally {
    await b.close();
  }
};

export type { Reachable, TimerView, WorkView } from "./internal/explore/Engine.ts";
export type { SwarmOptions } from "./internal/explore/Search.ts";
export type { WorkerLike, WorkerSpec } from "./internal/explore/Workers.ts";
export { serveWorker } from "./internal/explore/Workers.ts";
export { assertModelHash, modelHashOf } from "./internal/explore/ModelHash.ts";
export {
  budgetLeft,
  choose,
  fakeState,
  now,
  recordCall,
  runningAs,
  spend,
} from "./internal/explore/Host.ts";
export {
  send,
  Snapshot,
  type Actor,
  type Bounds,
  type Fake,
  type Rule,
  type Scenario,
  type Step,
} from "./internal/explore/Engine.ts";
export type { HostProfile, Provided, World } from "./internal/explore/Host.ts";
export type { Coverage } from "./internal/explore/Search.ts";
export type { PathStep, Trace, Violation } from "./internal/explore/Trace.ts";
export type { StoryBindings } from "./internal/explore/Story.ts";
export {
  UnsupportedStoryTrace,
  ExploreError,
  HostFault,
  type EngineError,
} from "./internal/explore/Errors.ts";
export { iso, ruleFails, toCode } from "./internal/explore/Story.ts";
