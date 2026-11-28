import * as Domain from "@alchemy.run/domain";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export class Sent extends Domain.Event("Sent", { by: Schema.String }) {}

const Fast = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 }));
const Slow = Schema.Int.check(Schema.isBetween({ minimum: 20, maximum: 30 }));
const Limit = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 40 }));

export class Send extends Domain.Command("Send", {
  input: { id: Schema.String, fast: Fast, slow: Slow, limit: Limit },
  events: [Sent],
}) {}

export class Hold extends Domain.Command("Hold", {
  input: { id: Schema.String },
  events: [Sent],
}) {}

/**
 * A parcel offered to two couriers at once, for a limited time. Its handler
 * waits: how long each courier takes, and how long it waits for them, are
 * fields of the command.
 */
export class Dispatch extends Domain.Aggregate("Dispatch", {
  id: Schema.String,
  state: Schema.Struct({ by: Schema.String }),
  initial: { by: "" },
  transitions: {
    TheSlowCourierNeverWins: ({ events }) => events.every((event) => event.by !== "slow"),
    SomeoneAlwaysAnswers: ({ events }) => events.every((event) => event.by !== "nobody"),
  },
  commands: [Send, Hold],
  keyOf: (command) => command.id,
  decide: {
    Send: Effect.fn(function* (_dispatch, command) {
      const won = yield* Effect.race(
        Effect.as(Effect.sleep(command.fast * 2), "fast"),
        Effect.as(Effect.sleep(command.slow * 2), "slow"),
        // An odd number of milliseconds: the limit never ends with a courier.
      ).pipe(Effect.timeoutOption(command.limit * 2 + 1));
      return [new Sent({ by: Option.getOrElse(won, () => "nobody") })];
    }),
    // Waits for an answer no one gives.
    Hold: Effect.fn(function* () {
      const answer = yield* Deferred.make<string>();
      return [new Sent({ by: yield* Deferred.await(answer) })];
    }),
  },
  evolve: { Sent: (_dispatch, event) => ({ by: event.by }) },
}) {}
