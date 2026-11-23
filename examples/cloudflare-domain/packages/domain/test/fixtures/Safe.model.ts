import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Coffer, type CofferState } from "./Coffer.aggregate.ts";
import {
  BringForward,
  DoubleDeposits,
  DropDeposits,
  ForgetOwner,
  SumUp,
} from "./Coffer.history.ts";

const forward = (state: typeof CofferState.Type) => ({
  owner: state.owner,
  balance: state.balance,
});

/** A coffer as its owner reads it. The roll-up says the same as the events. */
export class Holding extends Domain.View("Holding", {
  from: [Coffer],
  key: Coffer,
  state: Schema.Struct({ owner: Schema.String, balance: Schema.Int }),
  initial: { owner: "", balance: 0 },
  evolve: {
    Opened: (holding, e) => ({ ...holding, owner: e.owner }),
    Deposited: (holding, e) => ({ ...holding, balance: holding.balance + e.amount }),
    Withdrawn: (holding, e) => ({ ...holding, balance: holding.balance - e.amount }),
    BroughtForward: (_, e) => forward(e.state),
    Summed: (_, e) => ({ owner: e.owner, balance: e.balance }),
  },
}) {}

/** How often a coffer was paid into. A roll-up does not say: built after one, it starts at none. */
export class Activity extends Domain.View("Activity", {
  from: [Coffer],
  key: Coffer,
  state: Schema.Struct({ payments: Schema.Int }),
  initial: { payments: 0 },
  evolve: {
    Deposited: (activity) => ({ payments: activity.payments + 1 }),
    BroughtForward: (activity) => activity,
  },
}) {}

/** Every coffer's money, as one number. The roll-up adds what the events it replaces did. */
export class Reserves extends Domain.View("Reserves", {
  from: [Coffer],
  key: Schema.String,
  keyOf: { Coffer: () => "all" },
  state: Schema.Struct({ total: Schema.Int }),
  initial: { total: 0 },
  evolve: {
    Deposited: (reserves, e) => ({ total: reserves.total + e.amount }),
    Withdrawn: (reserves, e) => ({ total: reserves.total - e.amount }),
    BroughtForward: (reserves, e) => ({ total: reserves.total + e.state.balance }),
    Summed: (reserves, e) => ({ total: reserves.total + e.balance }),
  },
}) {}

/** Coffers with a roll-up that loses nothing and a rewrite no rule minds. */
export class Safe extends Domain.Model("Safe", {
  aggregates: [Coffer],
  views: [Holding, Reserves],
  rewrites: [ForgetOwner],
  compactions: [BringForward],
}) {}
export const SafeLive = BringForward.toLayer(
  Effect.succeed(Effect.fn(function* (_batch: Domain.Compaction.Batch<typeof Coffer>) {})),
);

/** Every model here has the one aggregate, and callers send it the same commands. */
export class SafeApi extends Domain.Api("SafeApi", {
  model: Safe,
  commands: ["Open", "Deposit", "Withdraw"],
}) {}

/** The same, read by a view whose roll-up handler forgets what the events said. */
export class Forgetful extends Domain.Model("Forgetful", {
  aggregates: [Coffer],
  views: [Holding, Activity],
  compactions: [BringForward],
}) {}

/** The same, with a rewrite that takes away what a withdrawal relied on. */
export class Careless extends Domain.Model("CarelessSafe", {
  aggregates: [Coffer],
  views: [Holding],
  rewrites: [DropDeposits],
}) {}

/** The same, with a rewrite that only adds money: no proof says so, and no sequence minds. */
export class Generous extends Domain.Model("Generous", {
  aggregates: [Coffer],
  views: [Holding],
  rewrites: [DoubleDeposits],
}) {}

/** The same, with a roll-up that leaves part of the state out. */
export class Lossy extends Domain.Model("Lossy", {
  aggregates: [Coffer],
  views: [Holding],
  compactions: [SumUp],
}) {}
export const LossyLive = SumUp.toLayer(
  Effect.succeed(Effect.fn(function* (_batch: Domain.Compaction.Batch<typeof Coffer>) {})),
);
