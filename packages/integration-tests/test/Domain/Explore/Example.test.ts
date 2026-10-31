/** The example of the Explore docs page, run as written. */
import * as Domain from "@alchemy.run/domain";
import * as Explore from "@alchemy.run/domain/Explore";
import { Story } from "@alchemy.run/domain/Story";
import { describe, expect, it } from "@alchemy.run/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

class HoldArmed extends Domain.Event("HoldArmed", { expiresAt: Schema.Number }) {}
class HoldPaused extends Domain.Event("HoldPaused") {}
class HoldResumed extends Domain.Event("HoldResumed") {}
class HoldExpired extends Domain.Event("HoldExpired") {}

class PlaceHold extends Domain.Command("PlaceHold", {
  target: Schema.String,
  input: { expiresAt: Schema.Number },
  events: [HoldArmed],
}) {}
class PauseHold extends Domain.Command("PauseHold", {
  target: Schema.String,
  events: [HoldPaused],
}) {}
class ResumeHold extends Domain.Command("ResumeHold", {
  target: Schema.String,
  events: [HoldResumed, HoldArmed],
}) {}
class ExpireHold extends Domain.Command("ExpireHold", {
  target: Schema.String,
  events: [HoldExpired],
}) {}

class Hold extends Domain.Aggregate("Hold", {
  id: Schema.String,
  state: Schema.Struct({
    status: Schema.Literals(["none", "held", "paused", "expired"]),
    expiresAt: Schema.Number,
  }),
  initial: { status: "none", expiresAt: 0 },
  commands: [PlaceHold, PauseHold, ResumeHold, ExpireHold],
  decide: {
    PlaceHold: (_state, { expiresAt }) => [new HoldArmed({ expiresAt })],
    PauseHold: (state) => (state.status === "held" ? [new HoldPaused()] : []),
    ResumeHold: (state) =>
      state.status === "paused"
        ? [new HoldResumed(), new HoldArmed({ expiresAt: state.expiresAt })]
        : [],
    // A paused hold does not expire: the command runs and records nothing.
    ExpireHold: (state) => (state.status === "held" ? [new HoldExpired()] : []),
  },
  evolve: {
    HoldArmed: (_state, { expiresAt }) => ({ status: "held" as const, expiresAt }),
    HoldPaused: (state) => ({ ...state, status: "paused" as const }),
    HoldResumed: (state) => ({ ...state, status: "held" as const }),
    HoldExpired: (state) => ({ ...state, status: "expired" as const }),
  },
}) {}

class HoldExpiry extends Domain.Policy("HoldExpiry", { from: Hold, on: [HoldArmed] }) {}
const HoldExpiryLive = HoldExpiry.toLayer(
  Effect.gen(function* () {
    const holds = yield* Hold;
    return Effect.fn(function* ({ source, event }) {
      yield* holds
        .schedule(source, new ExpireHold(), {
          at: DateTime.makeUnsafe(event.expiresAt),
          commandId: `expire:${source.id}`,
        })
        // The bug: a resume after the stale run lands here, and no timer is armed.
        .pipe(Effect.catchTag("AlreadyExecuted", () => Effect.void));
    });
  }),
);

class Holds extends Domain.Model("Holds", { aggregates: [Hold], policies: [HoldExpiry] }) {}

const start = Date.parse("2030-01-01T00:00:00Z");
const day = 86_400_000;

const actor = (
  key: string,
  command: Domain.Aggregate.CommandOf<typeof Hold>,
  enabled: (status: string | undefined) => boolean,
): Explore.Actor => ({
  key,
  enabled: (s) => s.budget(key) > 0 && enabled(s.state("Hold", "h1")?.status),
  run: (ctx) =>
    Effect.suspend(() => {
      Explore.spend(key);
      return Explore.send(ctx, Hold, "h1", command, { commandId: `api:${key}` });
    }),
});

const heldHasTimer: Explore.Rule = {
  id: "HELD-HAS-TIMER",
  kind: "quiescent",
  reachable: {
    text: "a hold is held",
    state: (s) => s.instances("Hold").some(([, hold]) => hold.status === "held"),
  },
  check: (s) => {
    for (const [id, hold] of s.instances("Hold"))
      if (hold.status === "held" && s.timers({ agg: "Hold", id }).length === 0)
        return `${id} is held and has no expiry timer`;
    return undefined;
  },
  // Two days later a held hold has expired. The Story fails here on the bug.
  storyTail: () => ({
    code: [
      `    Story.clock("2030-01-03T00:00:00.000Z"),`,
      `    Story.state(Hold.ref("h1"), (s) => { if (s.status !== "expired") throw new Error(ruleFails("HELD-HAS-TIMER")); }),`,
    ],
    steps: [
      Story.clock("2030-01-03T00:00:00.000Z"),
      Story.state(Hold.ref("h1"), (s) => {
        if (s.status !== "expired") throw new Error(Explore.ruleFails("HELD-HAS-TIMER"));
      }),
    ],
  }),
};

const scenario: Explore.Scenario = {
  name: "holds",
  model: Holds,
  layer: Holds.layer(HoldExpiryLive),
  fakes: [],
  actors: [
    actor("place", new PlaceHold({ expiresAt: start + day }), (status) => status === undefined),
    actor("pause", new PauseHold(), (status) => status === "held"),
    actor("resume", new ResumeHold(), (status) => status === "paused"),
  ],
  rules: [heldHasTimer],
  bounds: { depth: 12, budgets: { place: 1, pause: 1, resume: 1 } },
  startTimeMillis: start,
};

const story = Story.make(Holds, { layer: HoldExpiryLive });

describe("the docs example", () => {
  it("finds the lost timer, and the Story fails on the rule", async () => {
    const report = await Explore.run(scenario);
    expect({
      coverage: report.coverage,
      states: report.states,
      complete: report.complete,
      proof: report.proof,
      verdicts: report.ruleVerdicts.map((v) => [v.rule, v.verdict]),
    }).toEqual({
      coverage: { _tag: "Exhausted" },
      states: 15,
      complete: true,
      proof: false,
      verdicts: [
        ["DEFECT", "HELD"],
        ["DEAD-LETTER", "HELD"],
        ["TIMER-REARM", "BROKEN"],
        ["HELD-HAS-TIMER", "BROKEN"],
      ],
    });
    const broken = report.violations.find((v) => v.rule === "HELD-HAS-TIMER")!;
    expect(broken.message).toBe("h1 is held and has no expiry timer");
    expect(broken.path.map((step) => step.label)).toEqual([
      "place",
      "pause",
      "HoldExpiry ← HoldArmed (Hold/h1#1)",
      "timer ExpireHold on Hold/h1 at +1d",
      "resume",
      "HoldExpiry ← HoldArmed (Hold/h1#4)",
    ]);
    const out = await Explore.toStory(scenario, broken, {
      ref: (aggregate, id) => `${aggregate}.ref(${JSON.stringify(id)})`,
      aggregate: () => Hold,
      header: () => "",
      run: (steps) => story(...steps),
    });
    expect(out).not.toBeInstanceOf(Explore.UnsupportedStoryTrace);
    expect((out as { code: string }).code).toContain("new ResumeHold");
  });

  it("the Effect form gives the same report", async () => {
    const report = await Effect.runPromise(Explore.explore(scenario));
    expect(report.vacuous).toEqual([]);
    expect(report.violations.map((v) => v.rule).sort()).toEqual(["HELD-HAS-TIMER", "TIMER-REARM"]);
  });

  it("the swarm finds it from a seed", async () => {
    const report = await Explore.run(scenario, {
      search: { kind: "swarm", seeds: [1, 2], walks: 200, depth: 12 },
    });
    expect(report.coverage._tag).toBe("Sampled");
    expect(report.violations.map((v) => v.rule)).toContain("HELD-HAS-TIMER");
  });
});
