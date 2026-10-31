import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

/** How long an alarm waits in `armed` before it rings. */
export const ALARM_DELAY = "2 seconds";

export class AlarmArmed extends Domain.Event("AlarmArmed") {}
export class AlarmDisarmed extends Domain.Event("AlarmDisarmed") {}
export class AlarmRang extends Domain.Event("AlarmRang") {}

export class ArmAlarm extends Domain.Command("ArmAlarm", {
  target: Schema.String,
  events: [AlarmArmed],
}) {}
export class DisarmAlarm extends Domain.Command("DisarmAlarm", {
  target: Schema.String,
  events: [AlarmDisarmed],
}) {}
export class RingAlarm extends Domain.Command("RingAlarm", {
  target: Schema.String,
  events: [AlarmRang],
}) {}

export class Alarm extends Domain.Aggregate("Alarm", {
  id: Schema.String,
  state: Schema.Struct({ phase: Schema.Literals(["off", "armed"]), rang: Schema.Number }),
  initial: { phase: "off", rang: 0 },
  commands: [ArmAlarm, DisarmAlarm, RingAlarm],
  decide: {
    ArmAlarm: () => [new AlarmArmed()],
    DisarmAlarm: () => [new AlarmDisarmed()],
    RingAlarm: () => [new AlarmRang()],
  },
  evolve: {
    AlarmArmed: (s) => ({ ...s, phase: "armed" as const }),
    AlarmDisarmed: (s) => ({ ...s, phase: "off" as const }),
    AlarmRang: (s) => ({ ...s, rang: s.rang + 1 }),
  },
  phases: {
    off: { on: { AlarmArmed: "armed" } },
    armed: { on: { AlarmDisarmed: "off" }, after: { [ALARM_DELAY]: RingAlarm } },
  },
  phaseOf: (s) => s.phase,
  when: { ArmAlarm: ["off"], DisarmAlarm: ["armed"], RingAlarm: ["armed"] },
}) {}

export class PulseStarted extends Domain.Event("PulseStarted") {}
export class PulseStopped extends Domain.Event("PulseStopped") {}

export class StartPulse extends Domain.Command("StartPulse", {
  target: Schema.String,
  events: [PulseStarted],
}) {}
/** Leaves its timer's phase and returns in one commit, so it arms the id it runs under. */
export class Beat extends Domain.Command("Beat", {
  target: Schema.String,
  events: [PulseStopped, PulseStarted],
}) {}

export class Pulse extends Domain.Aggregate("Pulse", {
  id: Schema.String,
  state: Schema.Struct({ phase: Schema.Literals(["idle", "beating"]), beats: Schema.Number }),
  initial: { phase: "idle", beats: 0 },
  commands: [StartPulse, Beat],
  decide: {
    StartPulse: () => [new PulseStarted()],
    Beat: () => [new PulseStopped(), new PulseStarted()],
  },
  evolve: {
    PulseStarted: (s) => ({ ...s, phase: "beating" as const }),
    PulseStopped: (s) => ({ phase: "idle" as const, beats: s.beats + 1 }),
  },
  phases: {
    idle: { on: { PulseStarted: "beating" } },
    beating: { on: { PulseStopped: "idle" }, after: { "1 second": Beat } },
  },
  phaseOf: (s) => s.phase,
  when: { StartPulse: ["idle"], Beat: ["beating"] },
}) {}

export class Alarms extends Domain.Model("Alarms", { aggregates: [Alarm, Pulse] }) {}
