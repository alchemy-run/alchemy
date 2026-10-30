import * as Domain from "@alchemy.run/domain";
import { Story } from "@alchemy.run/domain/Story";
import { describe, expect, it } from "@alchemy.run/test";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

class Opened extends Domain.Event("Opened") {}
class Paused extends Domain.Event("Paused") {}
class Resumed extends Domain.Event("Resumed") {}
class Stalled extends Domain.Event("Stalled", { reminders: Schema.Number }) {}
class Noted extends Domain.Event("Noted") {}
class Closed extends Domain.Event("Closed") {}

class Open extends Domain.Command("Open", { target: Schema.String, events: [Opened] }) {}
class Pause extends Domain.Command("Pause", { target: Schema.String, events: [Paused] }) {}
class Resume extends Domain.Command("Resume", { target: Schema.String, events: [Resumed] }) {}
// Pause and resume in one command: the instance leaves its phase and returns.
class Bounce extends Domain.Command("Bounce", {
  target: Schema.String,
  events: [Paused, Resumed],
}) {}
class Close extends Domain.Command("Close", { target: Schema.String, events: [Closed] }) {}
class Note extends Domain.Command("Note", { target: Schema.String, events: [Noted] }) {}
class MarkStalled extends Domain.Command("MarkStalled", {
  target: Schema.String,
  input: { reminders: Schema.Number },
  events: [Stalled],
}) {}

const State = Schema.Struct({
  phase: Schema.Literals(["new", "triage", "paused", "closed"]),
  stalls: Schema.Number,
});

class Ticket extends Domain.Aggregate("Ticket", {
  id: Schema.String,
  state: State,
  initial: { phase: "new", stalls: 0 },
  commands: [Open, Pause, Resume, Bounce, Close, Note, MarkStalled],
  decide: {
    Open: () => [new Opened()],
    Pause: () => [new Paused()],
    Resume: () => [new Resumed()],
    Bounce: () => [new Paused(), new Resumed()],
    Close: () => [new Closed()],
    Note: () => [new Noted()],
    MarkStalled: (_, cmd) => [new Stalled({ reminders: cmd.reminders })],
  },
  evolve: {
    Opened: (s) => ({ ...s, phase: "triage" as const }),
    Paused: (s) => ({ ...s, phase: "paused" as const }),
    Resumed: (s) => ({ ...s, phase: "triage" as const }),
    Closed: (s) => ({ ...s, phase: "closed" as const }),
    Noted: (s) => s,
    Stalled: (s) => ({ ...s, stalls: s.stalls + 1 }),
  },
  phases: {
    new: { on: { Opened: "triage" } },
    triage: {
      on: { Paused: "paused", Closed: "closed" },
      after: { "1 hour": (s) => new MarkStalled({ reminders: s.stalls + 1 }) },
    },
    paused: { on: { Resumed: "triage", Closed: "closed" } },
    closed: {},
  },
  phaseOf: (s) => s.phase,
  when: {
    Open: ["new"],
    Pause: ["triage"],
    Resume: ["paused"],
    Bounce: ["triage"],
    Close: ["triage", "paused"],
    Note: "*",
    MarkStalled: ["triage"],
  },
}) {}

class Tickets extends Domain.Model("Tickets", { aggregates: [Ticket] }) {}
const story = Story.make(Tickets, { layer: Layer.empty });
const t1 = Ticket.ref("t-1");

class Pinged extends Domain.Event("Pinged") {}
class Ping extends Domain.Command("Ping", { target: Schema.String, events: [Pinged] }) {}
// A timer in the initial phase, with its class in place of a function.
class Heartbeat extends Domain.Aggregate("Heartbeat", {
  id: Schema.String,
  state: Schema.Struct({ pings: Schema.Number }),
  initial: { pings: 0 },
  commands: [Ping],
  decide: { Ping: () => [new Pinged()] },
  evolve: { Pinged: (s) => ({ pings: s.pings + 1 }) },
  phases: { alive: { after: { "1 minute": Ping } } },
  phaseOf: () => "alive",
  when: { Ping: "*" },
}) {}
class PulseStarted extends Domain.Event("PulseStarted") {}
class PulseStopped extends Domain.Event("PulseStopped") {}
class StartPulse extends Domain.Command("StartPulse", {
  target: Schema.String,
  events: [PulseStarted],
}) {}
// Leaves its timer's phase and returns in one commit, so it arms the id it runs under.
class Beat extends Domain.Command("Beat", {
  target: Schema.String,
  events: [PulseStopped, PulseStarted],
}) {}
class Pulse extends Domain.Aggregate("Pulse", {
  id: Schema.String,
  state: Schema.Struct({ phase: Schema.Literals(["idle", "beating"]) }),
  initial: { phase: "idle" },
  commands: [StartPulse, Beat],
  decide: {
    StartPulse: () => [new PulseStarted()],
    Beat: () => [new PulseStopped(), new PulseStarted()],
  },
  evolve: {
    PulseStarted: () => ({ phase: "beating" as const }),
    PulseStopped: () => ({ phase: "idle" as const }),
  },
  phases: {
    idle: { on: { PulseStarted: "beating" } },
    beating: { on: { PulseStopped: "idle" }, after: { "1 minute": Beat } },
  },
  phaseOf: (s) => s.phase,
  when: { StartPulse: ["idle"], Beat: ["beating"] },
}) {}
class Hearts extends Domain.Model("Hearts", { aggregates: [Heartbeat, Pulse] }) {}

describe("Phase timers", () => {
  it.effect("a timer whose own commit leaves the phase and returns arms itself again", () =>
    Story.make(Hearts, { layer: Layer.empty })(
      Story.clock("2026-01-01T00:00:00Z"),
      Story.when(Pulse.ref("p-1"), new StartPulse()),
      Story.then(Pulse.ref("p-1"), new PulseStarted()),
      Story.clock("2026-01-01T00:01:00Z"),
      Story.then(Pulse.ref("p-1"), new PulseStopped(), new PulseStarted()),
      Story.clock("2026-01-01T00:02:00Z"),
      Story.then(Pulse.ref("p-1"), new PulseStopped(), new PulseStarted()),
    ),
  );

  it.effect("entering a phase arms its timer", () =>
    story(
      Story.clock("2026-01-01T00:00:00Z"),
      Story.when(t1, new Open()),
      Story.then(t1, new Opened()),
      Story.clock("2026-01-01T00:59:00Z"),
      Story.then(t1),
      Story.clock("2026-01-01T01:00:00Z"),
      Story.then(t1, new Stalled({ reminders: 1 })),
    ),
  );

  it.effect("leaving the phase cancels the timer", () =>
    story(
      Story.clock("2026-01-01T00:00:00Z"),
      Story.when(t1, new Open()),
      Story.clock("2026-01-01T00:30:00Z"),
      Story.when(t1, new Pause()),
      Story.then(t1, new Opened(), new Paused()),
      Story.clock("2026-01-01T02:00:00Z"),
      Story.then(t1),
    ),
  );

  it.effect("entering again arms it from that time", () =>
    story(
      Story.clock("2026-01-01T00:00:00Z"),
      Story.when(t1, new Open()),
      Story.clock("2026-01-01T00:30:00Z"),
      Story.when(t1, new Pause()),
      Story.when(t1, new Resume()),
      Story.then(t1, new Opened(), new Paused(), new Resumed()),
      Story.clock("2026-01-01T01:00:00Z"),
      Story.then(t1),
      Story.clock("2026-01-01T01:30:00Z"),
      Story.then(t1, new Stalled({ reminders: 1 })),
    ),
  );

  // issue #2804: the same deadline, armed again after it ran.
  it.effect("a timer that ran fires again after the phase is entered again", () =>
    story(
      Story.clock("2026-01-01T00:00:00Z"),
      Story.when(t1, new Open()),
      Story.clock("2026-01-01T01:00:00Z"),
      Story.then(t1, new Opened(), new Stalled({ reminders: 1 })),
      Story.when(t1, new Pause()),
      Story.when(t1, new Resume()),
      Story.then(t1, new Paused(), new Resumed()),
      Story.clock("2026-01-01T02:00:00Z"),
      Story.then(t1, new Stalled({ reminders: 2 })),
    ),
  );

  it.effect("a commit that leaves and returns arms the timer again", () =>
    story(
      Story.clock("2026-01-01T00:00:00Z"),
      Story.when(t1, new Open()),
      Story.clock("2026-01-01T00:30:00Z"),
      Story.when(t1, new Bounce()),
      Story.then(t1, new Opened(), new Paused(), new Resumed()),
      Story.clock("2026-01-01T01:00:00Z"),
      Story.then(t1),
      Story.clock("2026-01-01T01:30:00Z"),
      Story.then(t1, new Stalled({ reminders: 1 })),
    ),
  );

  it.effect("a commit that stays in the phase leaves the timer alone", () =>
    story(
      Story.clock("2026-01-01T00:00:00Z"),
      Story.when(t1, new Open()),
      Story.clock("2026-01-01T00:30:00Z"),
      Story.when(t1, new Note()),
      Story.then(t1, new Opened(), new Noted()),
      Story.clock("2026-01-01T01:00:00Z"),
      Story.then(t1, new Stalled({ reminders: 1 })),
    ),
  );

  it.effect("a first commit that stays in the initial phase arms its timers", () =>
    Story.make(Hearts, { layer: Layer.empty })(
      Story.clock("2026-01-01T00:00:00Z"),
      Story.when(Heartbeat.ref("h-1"), new Ping()),
      Story.then(Heartbeat.ref("h-1"), new Pinged()),
      Story.clock("2026-01-01T00:01:00Z"),
      Story.then(Heartbeat.ref("h-1"), new Pinged()),
      // the timer is one-shot: it stays in its phase, so nothing arms it again
      Story.clock("2026-01-01T00:05:00Z"),
      Story.then(Heartbeat.ref("h-1")),
    ),
  );
});

class Finished extends Domain.Event("Finished") {}
class Nope extends Domain.Rejection("Nope") {}
class Finish extends Domain.Command("Finish", { target: Schema.String, events: [Finished] }) {}
class Tell extends Domain.Command("Tell", {
  target: Schema.String,
  input: { text: Schema.String },
  events: [Finished],
}) {}
class Refusing extends Domain.Command("Refusing", {
  target: Schema.String,
  events: [Finished],
  rejects: [Nope],
}) {}
class Job extends Domain.Aggregate("Job", {
  id: Schema.String,
  state: Schema.Struct({ phase: Schema.Literals(["idle", "over"]) }),
  initial: { phase: "idle" },
  commands: [Finish, Tell, Refusing],
  decide: {
    Finish: () => [new Finished()],
    Tell: () => [new Finished()],
    Refusing: () => [new Finished()],
  },
  evolve: { Finished: () => ({ phase: "over" as const }) },
  phases: { idle: { on: { Finished: "over" } }, over: {} },
  phaseOf: (s) => s.phase,
  when: { Finish: ["idle"], Tell: "*", Refusing: "*" },
}) {}

/** The problems of Job with these timers on its `idle` phase. */
const problems = (after: object) => {
  const broken = Object.create(Job) as Domain.Aggregate.Any;
  Object.defineProperty(broken, "definition", {
    value: {
      ...Job.definition,
      phases: { ...Job.definition.phases, idle: { ...Job.definition.phases!.idle, after } },
    },
  });
  return Domain.verify(class extends Domain.Model("Broken", { aggregates: [broken] }) {}).map(
    (problem) => problem.message,
  );
};

describe("Domain.verify on phase timers", () => {
  it("passes well-formed timers", () => {
    expect(Domain.verify(Tickets)).toEqual([]);
    expect(problems({ "1 hour": Finish, "2 hours": () => new Finish() })).toEqual([]);
  });

  it("finds a delay that is not a duration", () => {
    expect(problems({ "24h": Finish })).toEqual([
      'Job.phases.idle.after["24h"] is not a duration: write it like "24 hours"',
    ]);
  });

  it("finds a command the aggregate does not handle", () => {
    expect(problems({ "1 hour": Open })).toEqual([
      'Job.phases.idle.after["1 hour"] is not a command of Job',
    ]);
  });

  it("finds a command that can reject", () => {
    expect(problems({ "1 hour": Refusing })).toEqual([
      'Job.phases.idle.after["1 hour"]: Refusing declares rejections, and nobody waits for a timer',
    ]);
  });

  it("finds a command class that needs input", () => {
    expect(problems({ "1 hour": Tell })).toEqual([
      'Job.phases.idle.after["1 hour"]: Tell takes input: use a function of the state',
    ]);
  });

  it("finds a timer its phase can never run", () => {
    const over = Object.create(Job) as Domain.Aggregate.Any;
    Object.defineProperty(over, "definition", {
      value: {
        ...Job.definition,
        phases: { ...Job.definition.phases, over: { after: { "1 hour": Finish } } },
      },
    });
    expect(
      Domain.verify(class extends Domain.Model("Broken", { aggregates: [over] }) {}).map(
        (problem) => problem.message,
      ),
    ).toEqual(["Job.phases.over.after[\"1 hour\"]: when does not let Finish run in 'over'"]);
  });
});

export const typeChecks = () => {
  Domain.Aggregate("Rejecting", {
    id: Schema.String,
    state: Schema.Struct({}),
    initial: {},
    commands: [Refusing],
    decide: { Refusing: () => [new Finished()] },
    evolve: { Finished: (s) => s },
    phases: {
      only: {
        // @ts-expect-error a timer's command must never reject
        after: { "1 hour": Refusing },
      },
    },
    phaseOf: () => "only",
    when: { Refusing: "*" },
  });
};
