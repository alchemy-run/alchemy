/**
 * The shapes the latency benchmark times a command on. Each is one aggregate
 * that counts ticks, and differs only in the views its events reach, since
 * that is what a command waits for under `consistency: "strong"`:
 *
 * - `Bare`: no view;
 * - `One`: one view, keyed by the aggregate;
 * - `Four`: four views, keyed by the aggregate;
 * - `Chain`: a view fed by a view, keyed by the aggregate;
 * - `Shared`: one view keyed by a group many instances share.
 */
import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

const count = {
  state: Schema.Struct({ count: Schema.Int }),
  initial: { count: 0 },
} as const;
const tick = (state: { readonly count: number }) => ({ count: state.count + 1 });

export class BareTicked extends Domain.Event("BareTicked", {}) {}
export class TickBare extends Domain.Command("TickBare", {
  input: { id: Schema.String },
  events: [BareTicked],
}) {}
export class Bare extends Domain.Aggregate("Bare", {
  id: Schema.String,
  ...count,
  commands: [TickBare],
  keyOf: (command) => command.id,
  decide: { TickBare: () => [new BareTicked({})] },
  evolve: { BareTicked: tick },
}) {}

export class OneTicked extends Domain.Event("OneTicked", {}) {}
export class TickOne extends Domain.Command("TickOne", {
  input: { id: Schema.String },
  events: [OneTicked],
}) {}
export class One extends Domain.Aggregate("One", {
  id: Schema.String,
  ...count,
  commands: [TickOne],
  keyOf: (command) => command.id,
  decide: { TickOne: () => [new OneTicked({})] },
  evolve: { OneTicked: tick },
}) {}
export class OneView extends Domain.View("OneView", {
  from: [One],
  key: One,
  ...count,
  evolve: { OneTicked: tick },
}) {}

export class FourTicked extends Domain.Event("FourTicked", {}) {}
export class TickFour extends Domain.Command("TickFour", {
  input: { id: Schema.String },
  events: [FourTicked],
}) {}
export class Four extends Domain.Aggregate("Four", {
  id: Schema.String,
  ...count,
  commands: [TickFour],
  keyOf: (command) => command.id,
  decide: { TickFour: () => [new FourTicked({})] },
  evolve: { FourTicked: tick },
}) {}
export class FourA extends Domain.View("FourA", {
  from: [Four],
  key: Four,
  ...count,
  evolve: { FourTicked: tick },
}) {}
export class FourB extends Domain.View("FourB", {
  from: [Four],
  key: Four,
  ...count,
  evolve: { FourTicked: tick },
}) {}
export class FourC extends Domain.View("FourC", {
  from: [Four],
  key: Four,
  ...count,
  evolve: { FourTicked: tick },
}) {}
export class FourD extends Domain.View("FourD", {
  from: [Four],
  key: Four,
  ...count,
  evolve: { FourTicked: tick },
}) {}

export class ChainTicked extends Domain.Event("ChainTicked", {}) {}
export class TickChain extends Domain.Command("TickChain", {
  input: { id: Schema.String },
  events: [ChainTicked],
}) {}
export class Chain extends Domain.Aggregate("Chain", {
  id: Schema.String,
  ...count,
  commands: [TickChain],
  keyOf: (command) => command.id,
  decide: { TickChain: () => [new ChainTicked({})] },
  evolve: { ChainTicked: tick },
}) {}
/** Passes every tick on to {@link ChainSecond}. */
export class ChainFirst extends Domain.View("ChainFirst", {
  from: [Chain],
  key: Chain,
  ...count,
  evolve: { ChainTicked: tick },
}) {}
export class ChainSecond extends Domain.View("ChainSecond", {
  from: [ChainFirst],
  key: Chain,
  ...count,
  evolve: { ChainTicked: tick },
}) {}

export class SharedTicked extends Domain.Event("SharedTicked", { group: Schema.String }) {}
export class TickShared extends Domain.Command("TickShared", {
  input: { id: Schema.String, group: Schema.String },
  events: [SharedTicked],
}) {}
export class Shared extends Domain.Aggregate("Shared", {
  id: Schema.String,
  ...count,
  commands: [TickShared],
  keyOf: (command) => command.id,
  decide: { TickShared: (_, command) => [new SharedTicked({ group: command.group })] },
  evolve: { SharedTicked: tick },
}) {}
/** One count per group, fed by every instance in it. */
export class SharedByGroup extends Domain.View("SharedByGroup", {
  from: [Shared],
  key: Schema.String,
  keyOf: { Shared: ({ event }) => event.group },
  ...count,
  evolve: { SharedTicked: tick },
}) {}

export const latencyAggregates = [Bare, One, Four, Chain, Shared] as const;
export const latencyViews = [
  OneView,
  FourA,
  FourB,
  FourC,
  FourD,
  ChainFirst,
  ChainSecond,
  SharedByGroup,
] as const;
