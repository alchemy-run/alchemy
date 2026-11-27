import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const Amount = Schema.Int.check(Schema.isGreaterThan(0));

export class Stocked extends Domain.Event("Stocked", { amount: Schema.Int }) {}

export class Sent extends Domain.Event("Sent", { amount: Schema.Int }) {}

export class Received extends Domain.Event("Received", { amount: Schema.Int }) {}

export class NotEnough extends Domain.Rejection("NotEnough") {}

export class Stock extends Domain.Command("Stock", {
  input: { id: Schema.String, amount: Amount },
  events: [Stocked],
}) {}

/** A till: money is put in by its own command, and moved between tills by a decision. */
export class Till extends Domain.Aggregate("Till", {
  id: Schema.String,
  state: Schema.Struct({ balance: Schema.Int }),
  initial: { balance: 0 },
  invariants: { NeverNegative: (till) => till.balance >= 0 },
  commands: [Stock],
  keyOf: (cmd) => cmd.id,
  events: [Sent, Received],
  decide: {
    Stock: (_, command) => [new Stocked({ amount: command.amount })],
  },
  evolve: {
    Stocked: (till, event) => ({ balance: till.balance + event.amount }),
    Sent: (till, event) => ({ balance: till.balance - event.amount }),
    Received: (till, event) => ({ balance: till.balance + event.amount }),
  },
}) {}

export class MoveMoney extends Domain.Command("MoveMoney", {
  input: { from: Schema.String, to: Schema.String, amount: Amount },
  events: [Sent, Received],
  rejects: [NotEnough],
}) {}

/** Takes from one till what it gives the other, and only what is there. */
export class Move extends Domain.Decision(MoveMoney, {
  reads: { from: Till, to: Till },
  keyOf: (cmd) => ({ from: cmd.from, to: cmd.to }),
  decide: ({ from, to }, cmd) =>
    cmd.amount > from.state.balance
      ? new NotEnough()
      : [
          from.record(new Sent({ amount: cmd.amount })),
          to.record(new Received({ amount: cmd.amount })),
        ],
  transitions: {
    MoneyIsConserved: ({ before, after }) =>
      after.from.balance + after.to.balance === before.from.balance + before.to.balance,
  },
}) {}

/** Whenever a till is stocked, a cent of it goes to the house's till. */
export class Tithe extends Domain.Policy("Tithe", { from: Till, on: [Stocked] }) {}

export const TitheLive = Tithe.toLayer(
  Effect.gen(function* () {
    const move = yield* Move;
    return Effect.fn(function* ({ source }) {
      yield* move
        .send(new MoveMoney({ from: source.id, to: "house", amount: 1 }))
        .pipe(Effect.catchTag("NotEnough", () => Effect.void));
    });
  }),
);

const total = (amounts: ReadonlyArray<number>) => amounts.reduce((sum, amount) => sum + amount, 0);

/** Tills that move money between them: what they hold is what was put in. */
export class Tills extends Domain.Model("Tills", {
  aggregates: [Till],
  decisions: [Move],
  policies: [Tithe],
  invariants: {
    HoldsWhatWasStocked: (tills) =>
      total(tills.Till.map((till) => till.state.balance)) ===
      total(
        tills.Till.flatMap((till) =>
          till.events.flatMap((event) => (event._tag === "Stocked" ? [event.amount] : [])),
        ),
      ),
  },
}) {}

export class TillsApi extends Domain.Api("TillsApi", {
  model: Tills,
  commands: ["Stock", "MoveMoney"],
  views: [],
  streams: [],
  queries: [],
}) {}

export class SkimMoney extends Domain.Command("SkimMoney", {
  input: { from: Schema.String, to: Schema.String, amount: Amount },
  events: [Sent, Received],
  rejects: [NotEnough],
}) {}

/** Keeps a cent of every move: both tills stay in order, and money is lost. */
export class Skim extends Domain.Decision(SkimMoney, {
  reads: { from: Till, to: Till },
  keyOf: (cmd) => ({ from: cmd.from, to: cmd.to }),
  decide: ({ from, to }, cmd) =>
    cmd.amount > from.state.balance
      ? new NotEnough()
      : [
          from.record(new Sent({ amount: cmd.amount })),
          to.record(new Received({ amount: cmd.amount - 1 })),
        ],
  transitions: {
    MoneyIsConserved: ({ before, after }) =>
      after.from.balance + after.to.balance === before.from.balance + before.to.balance,
  },
}) {}

/** The same tills, moved between by a decision that loses a cent each time. */
export class Leaky extends Domain.Model("Leaky", {
  aggregates: [Till],
  decisions: [Skim],
  invariants: {
    HoldsWhatWasStocked: (tills) =>
      total(tills.Till.map((till) => till.state.balance)) ===
      total(
        tills.Till.flatMap((till) =>
          till.events.flatMap((event) => (event._tag === "Stocked" ? [event.amount] : [])),
        ),
      ),
  },
}) {}

export class LeakyApi extends Domain.Api("LeakyApi", {
  model: Leaky,
  commands: ["Stock", "SkimMoney"],
  views: [],
  streams: [],
  queries: [],
}) {}
