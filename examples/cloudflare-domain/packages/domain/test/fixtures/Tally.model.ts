import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class RoundOpened extends Domain.Event("RoundOpened", {}) {}

export class AlreadyOpen extends Domain.Rejection("AlreadyOpen", {}) {}

export class OpenRound extends Domain.Command("OpenRound", {
  input: { id: Schema.String },
  events: [RoundOpened],
  rejects: [AlreadyOpen],
}) {}

export class Round extends Domain.Aggregate("Round", {
  id: Schema.String,
  state: Schema.Struct({ open: Schema.Boolean }),
  initial: { open: false },
  commands: [OpenRound],
  keyOf: (cmd) => cmd.id,
  decide: {
    OpenRound: (round) => (round.open ? new AlreadyOpen() : [new RoundOpened({})]),
  },
  evolve: { RoundOpened: () => ({ open: true }) },
}) {}

export class OneAdded extends Domain.Event("OneAdded", {}) {}

export class Doubled extends Domain.Event("Doubled", {}) {}

export class AddOne extends Domain.Command("AddOne", {
  input: { id: Schema.String },
  events: [OneAdded],
}) {}

export class Double extends Domain.Command("Double", {
  input: { id: Schema.String },
  events: [Doubled],
}) {}

/** A round's score, kept under the round's id. */
export class Score extends Domain.Aggregate("Score", {
  id: Schema.String,
  state: Schema.Struct({ points: Schema.Int }),
  initial: { points: 0 },
  commands: [AddOne, Double],
  keyOf: (cmd) => cmd.id,
  decide: {
    AddOne: () => [new OneAdded({})],
    Double: () => [new Doubled({})],
  },
  evolve: {
    OneAdded: (score) => ({ points: score.points + 1 }),
    Doubled: (score) => ({ points: score.points * 2 }),
  },
}) {}

/** Whenever a round opens, give it a point. */
export class Award extends Domain.Policy("Award", { from: Round, on: [RoundOpened] }) {}

export const AwardLive = Award.toLayer(
  Effect.gen(function* () {
    const scores = yield* Score;
    return Effect.fn(function* ({ source }) {
      yield* scores.send(new AddOne({ id: source.id }));
    });
  }),
);

/** Whenever a round opens, double its score. */
export class Bonus extends Domain.Policy("Bonus", { from: Round, on: [RoundOpened] }) {}

export const BonusLive = Bonus.toLayer(
  Effect.gen(function* () {
    const scores = yield* Score;
    return Effect.fn(function* ({ source }) {
      yield* scores.send(new Double({ id: source.id }));
    });
  }),
);

/**
 * Two policies react to the same event and write the same score. Award is
 * listed first, so a reader expects a point, then the bonus: two points. The
 * kernel promises no such order.
 */
export class Tally extends Domain.Model("Tally", {
  aggregates: [Round, Score],
  policies: [Award, Bonus],
  invariants: {
    AnOpenRoundScoresTwo: (tally) => tally.Score.every((score) => score.state.points === 2),
  },
}) {}

export class TallyApi extends Domain.Api("TallyApi", {
  model: Tally,
  commands: ["OpenRound"],
  views: [],
  streams: [],
  queries: [],
}) {}
