/**
 * The structured trace: the source of truth of a counterexample. A
 * trace names each move, each choice (label, option count, option) and the
 * canonical digest after each step; `replay` re-runs it on a FRESH build and
 * checks every digest and the rule failure.
 */
import { canonical, digest, digestHex } from "./Canonical.ts";
import {
  canonOf,
  checkRules,
  enabled,
  freshWorld,
  runOnce,
  stepOf,
  type Built,
  type Leaf,
  type Move,
  type Scenario,
} from "./Engine.ts";
import { EngineFault } from "./Errors.ts";
import type { Call, ScriptEntry, Send, World } from "./Host.ts";
import { modelHashOf } from "./ModelHash.ts";

export interface TraceStep {
  readonly move: string;
  readonly label: string;
  readonly choices: ReadonlyArray<ScriptEntry>;
  /** The canonical digest after the step (hex). */
  readonly digest: string;
}

export interface Trace {
  readonly version: 3;
  readonly scenario: string;
  /** The hash of the model's definitions: a replay on another model is refused. */
  readonly modelHash: string;
  readonly fingerprint: string;
  readonly rule: string;
  readonly steps: ReadonlyArray<TraceStep>;
}

/** A readable step of a path (the report and the Story read it). */
export interface PathStep {
  readonly label: string;
  readonly kind: Move["kind"];
  readonly at: number;
  readonly choices: ReadonlyArray<ScriptEntry>;
  readonly commits: ReadonlyArray<{
    agg: string;
    id: string;
    tag: string;
    events: ReadonlyArray<string>;
    by: string;
  }>;
  readonly calls: ReadonlyArray<Call>;
  readonly failures: ReadonlyArray<{ where: string; error: string }>;
  readonly defects: ReadonlyArray<{ where: string; error: string }>;
  readonly sends: ReadonlyArray<Send>;
  readonly enqueued: ReadonlyArray<{ pk: string; source: string; seq: number; tag: string }>;
  readonly faults: ReadonlyArray<{ where: string; point: string }>;
}

export interface Violation {
  readonly rule: string;
  readonly message: string;
  readonly trace: Trace;
  readonly path: ReadonlyArray<PathStep>;
  readonly world: World;
}

/** What identifies a scenario run: config, bounds, rules, actors, fakes and model members. */
export const fingerprintOf = (s: Scenario, extra: unknown = {}): string => {
  const d = s.model.definitions as any;
  return digestHex(
    digest(
      canonical({
        name: s.name,
        modelHash: modelHashOf(s.model),
        start: s.startTimeMillis,
        bounds: s.bounds,
        host: {
          maxTries: s.host?.maxTries ?? 2,
          retryDefects: s.host?.retryDefects ?? [],
          views: s.host?.views ?? {},
          projections: s.host?.projections ?? {},
          faultable: s.host?.faultable ? String(s.host.faultable) : "none",
        },
        derived: s.derived ?? {},
        actors: s.actors.map((a) => a.key),
        fakes: s.fakes.map((f) => [f.name, f.initial()]),
        rules: s.rules.map((r) => `${r.kind}:${r.id}`),
        model: {
          aggregates: d.aggregates.map((a: any) => a.aggregateName),
          policies: d.policies.map((p: any) => p.policyName),
          views: d.views.map((v: any) => v.viewName),
          projections: d.projections.map((p: any) => p.projectionName),
        },
        extra,
      }),
    ),
  );
};

const pathStepOf = (move: Move, leaf: Leaf): PathStep => ({
  label: move.label,
  kind: move.kind,
  at: leaf.world.clock,
  choices: leaf.script,
  commits: leaf.log.commits.map((c) => ({
    agg: c.agg,
    id: c.id,
    tag: c.commandTag,
    events: c.events.map((e) => e._tag),
    by: c.by,
  })),
  calls: leaf.log.calls,
  failures: leaf.log.failures,
  defects: leaf.log.defects,
  sends: leaf.log.sends,
  enqueued: leaf.log.enqueued,
  faults: leaf.log.faults,
});

export interface Replayed {
  readonly steps: Array<TraceStep>;
  readonly path: Array<PathStep>;
  readonly world: World;
  /** The rules the last state (with the last step) breaks. */
  readonly breaks: Array<[string, string]>;
}

/** Re-run a chain of `(move, script)` from the root; a missing move or a changed choice is an engine error. */
export const replayChain = (
  b: Built,
  chain: ReadonlyArray<{ readonly move: string; readonly script: ReadonlyArray<ScriptEntry> }>,
): Replayed => {
  let world = freshWorld(b.scenario);
  const steps: Array<TraceStep> = [];
  const path: Array<PathStep> = [];
  let last: { move: Move; leaf: Leaf } | undefined;
  for (const link of chain) {
    const move = enabled(b, world).find((m) => m.key === link.move);
    if (!move)
      throw new EngineFault(
        "ReplayDiverged",
        `step ${steps.length + 1}: ${link.move} is not enabled`,
      );
    const leaf = runOnce(b, world, move, link.script);
    if (leaf.engine.length > 0) throw new EngineFault(leaf.engine[0]!.kind, leaf.engine[0]!.detail);
    if (leaf.script.length !== link.script.length)
      throw new EngineFault(
        "ReplayDiverged",
        `step ${steps.length + 1}: ${leaf.script.length} choices, the trace has ${link.script.length}`,
      );
    steps.push({
      move: move.key,
      label: move.label,
      choices: leaf.script,
      digest: digestHex(canonOf(leaf.world).digest),
    });
    path.push(pathStepOf(move, leaf));
    world = leaf.world;
    last = { move, leaf };
  }
  const breaks = checkRules(b, world, last ? stepOf(last.move, last.leaf) : undefined);
  return { steps, path, world, breaks };
};

/** Replay a trace on a build and check every digest and the rule failure. */
export const checkTrace = (b: Built, trace: Trace): Replayed => {
  const r = replayChain(
    b,
    trace.steps.map((s) => ({ move: s.move, script: s.choices })),
  );
  r.steps.forEach((s, i) => {
    if (s.digest !== trace.steps[i]!.digest)
      throw new EngineFault(
        "HiddenState",
        `step ${i + 1} (${s.label}): digest ${s.digest}, the trace has ${trace.steps[i]!.digest}`,
      );
  });
  if (!r.breaks.some(([id]) => id === trace.rule))
    throw new EngineFault("ReplayDiverged", `the replay does not break ${trace.rule}`);
  return r;
};
