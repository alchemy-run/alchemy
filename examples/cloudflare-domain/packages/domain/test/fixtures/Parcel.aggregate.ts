import * as Domain from "@alchemy.run/domain";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

/** The most a parcel may weigh, in grams. */
const LIMIT = 30_000;

const Item = Schema.Struct({
  grams: Schema.Int.check(Schema.isGreaterThan(0)),
  fragile: Schema.Boolean,
});
type Item = typeof Item.Type;

export class Packed extends Domain.Event("Packed", {
  grams: Schema.Int,
  items: Schema.Int,
  fragile: Schema.Boolean,
}) {}

export class Sent extends Domain.Event("Sent", { stops: Schema.Int }) {}

export class Returned extends Domain.Event("Returned", { grams: Schema.Int }) {}

export class TooHeavy extends Domain.Rejection("TooHeavy", { over: Schema.Int }) {}

export class NothingToSend extends Domain.Rejection("NothingToSend", {}) {}

export class Pack extends Domain.Command("Pack", {
  input: { id: Schema.String, items: Schema.Array(Item) },
  events: [Packed],
  rejects: [TooHeavy],
}) {}

export class Send extends Domain.Command("Send", {
  input: { id: Schema.String, stops: Schema.Int.check(Schema.isGreaterThan(0)) },
  events: [Sent],
  rejects: [NothingToSend],
}) {}

export class Return extends Domain.Command("Return", {
  input: { id: Schema.String, grams: Schema.Int.check(Schema.isGreaterThan(0)) },
  events: [Returned],
}) {}

/** A parcel that would weigh more than the limit, by how much. */
class Overweight extends Data.TaggedError("Overweight")<{ readonly over: number }> {}

/** Nothing was asked for. */
class Empty extends Data.TaggedError("Empty") {}

/** The weight of what is added, when the parcel can take it. */
const fits = (held: number, added: number): Result.Result<number, Overweight> =>
  held + added > LIMIT
    ? Result.fail(new Overweight({ over: held + added - LIMIT }))
    : Result.succeed(held + added);

/** The weight of one item, as an effect: an item is weighed one at a time. */
const weigh = (item: Item) => Effect.succeed(item.grams);

/** What a return takes off: never more than the parcel holds. */
const taken = (held: number, grams: number): Option.Option<number> =>
  Option.gen(function* () {
    const left = yield* Option.liftPredicate(held - grams, (n) => n >= 0);
    return held - left;
  });

/**
 * A parcel that is packed, sent and returned. Its handlers are written with
 * effects: a failure of a helper is handled, mapped or turned into a
 * rejection, and none of it is read differently from the plain code it is.
 */
export class Parcel extends Domain.Aggregate("Parcel", {
  id: Schema.String,
  state: Schema.Struct({
    grams: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    items: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    stops: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  initial: { grams: 0, items: 0, stops: 0 },
  invariants: {
    NeverOverTheLimit: (parcel) => parcel.grams <= LIMIT,
    AnEmptyParcelWeighsNothing: (parcel) => parcel.items > 0 || parcel.grams === 0,
  },
  transitions: {
    AReturnNeverAddsWeight: ({ before, after, command }) =>
      command._tag !== "Return" || after.grams <= before.grams,
  },
  commands: [Pack, Send, Return],
  keyOf: (command) => command.id,
  decide: {
    // Each item is weighed in turn, the total is checked, and the failure becomes the rejection.
    Pack: Effect.fn(function* (parcel, command) {
      const weights = yield* Effect.forEach(command.items, weigh);
      const added = yield* Effect.reduce(
        weights,
        () => 0,
        (total, grams) => Effect.succeed(total + grams),
      );
      const [total, fragile] = yield* Effect.all([
        Effect.fromResult(fits(parcel.grams, added)),
        Effect.succeed(command.items.some((item) => item.fragile)),
      ]).pipe(Effect.mapError((error) => new TooHeavy({ over: error.over })));
      return command.items.length === 0
        ? []
        : [new Packed({ grams: total - parcel.grams, items: command.items.length, fragile })];
    }),
    // A failure of a helper is caught by its tag and becomes a rejection.
    Send: (parcel, command) =>
      Effect.succeed(parcel.items).pipe(
        Effect.filterOrFail(
          (items) => items > 0,
          () => new Empty(),
        ),
        Effect.zip(Effect.succeed(command.stops)),
        Effect.map(([, stops]) => [new Sent({ stops })]),
        Effect.catchTag("Empty", () => Effect.fail(new NothingToSend())),
      ),
    // What a return takes off is an `Option`: nothing is recorded where there is nothing to take.
    Return: (parcel, command) =>
      Option.match(taken(parcel.grams, command.grams), {
        onNone: () => [],
        onSome: (grams) => [new Returned({ grams })],
      }),
  },
  evolve: {
    Packed: (parcel, event) => ({
      ...parcel,
      grams: parcel.grams + event.grams,
      items: parcel.items + event.items,
    }),
    Sent: (parcel, event) => ({ ...parcel, stops: parcel.stops + event.stops }),
    Returned: (parcel, event) => ({ ...parcel, grams: parcel.grams - event.grams }),
  },
}) {}
