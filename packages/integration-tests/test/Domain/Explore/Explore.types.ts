import * as Domain from "@alchemy.run/domain";
import * as Explore from "@alchemy.run/domain/Explore";
import * as Effect from "effect/Effect";
import { Arm, Job, JobModel, JobTimersLive, Src, Start, T0 } from "./Models.ts";

// A model class and its layer go in with no cast.
const armed: Explore.Rule = {
  id: "ARMED",
  kind: "quiescent",
  check: (s) => (s.timers({ agg: "Job" }).length > 0 ? undefined : "no timer"),
};
export const scenario: Explore.Scenario = {
  name: "job",
  model: JobModel,
  layer: JobModel.layer(JobTimersLive),
  actors: [
    {
      key: "arm",
      enabled: (s) => s.state("Job", "J1") === undefined,
      run: (ctx) =>
        Explore.send(ctx, Job, "J1", new Arm({ deadline: T0 }), { commandId: "api:arm" }),
    },
    {
      key: "bad",
      run: (ctx) =>
        // @ts-expect-error Start is a command of another aggregate
        Explore.send(ctx, Job, "J1", new Start(), { commandId: "api:bad" }),
    },
  ],
  fakes: [{ name: "clock", initial: () => ({ ticks: 0 }) }],
  rules: [armed],
  bounds: { depth: 8 },
  startTimeMillis: T0,
};

export const models: ReadonlyArray<Explore.Scenario["model"]> = [
  JobModel,
  Domain.Model("One", { aggregates: [Src] }),
  // @ts-expect-error an aggregate is not a model
  Job,
];

export const layers: ReadonlyArray<Explore.Scenario["layer"]> = [
  JobModel.layer(JobTimersLive),
  // @ts-expect-error a scenario's layer needs only `Platform`
  JobTimersLive,
];

export const rules: ReadonlyArray<Explore.Rule> = [
  armed,
  // @ts-expect-error `eventually` has `when`, `horizonMillis` and `goal`, not `check`
  { id: "E", kind: "eventually", check: () => undefined },
  // @ts-expect-error no such rule kind
  { id: "U", kind: "always", check: () => undefined },
];

export const search: ReadonlyArray<Explore.Search> = [
  { kind: "bfs" },
  { kind: "swarm", seeds: [1], walks: 10, depth: 8 },
  // @ts-expect-error a swarm needs seeds and a depth
  { kind: "swarm" },
  // @ts-expect-error only bfs and swarm
  { kind: "dfs" },
];

// The Effect form fails with the engine errors; violations stay data.
export const report: Effect.Effect<Explore.Report, Explore.ExploreError> =
  Explore.explore(scenario);

export const reading = Effect.map(report, (r) => {
  const proof: false = r.proof;
  const verdicts: ReadonlyArray<Explore.Verdict> = r.ruleVerdicts.map((v) => v.verdict);
  const tag: "Exhausted" | "WithinDepth" | "CutOff" | "Sampled" = r.coverage._tag;
  return { proof, verdicts, tag };
});
