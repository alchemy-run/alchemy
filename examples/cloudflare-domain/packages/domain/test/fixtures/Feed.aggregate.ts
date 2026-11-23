import * as Domain from "@alchemy.run/domain";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

/** The most readings one command records. */
const BATCH = 2;

const Reading = Schema.Int.check(Schema.isBetween({ minimum: -50, maximum: 150 }));

export class Recorded extends Domain.Event("Recorded", {
  count: Schema.Int,
  sum: Schema.Int,
  peak: Schema.Int,
}) {}

export class Skipped extends Domain.Event("Skipped", { count: Schema.Int }) {}

export class Faulty extends Domain.Rejection("Faulty", { reading: Schema.Int }) {}

export class Record extends Domain.Command("Record", {
  input: { id: Schema.String, readings: Schema.Array(Reading) },
  events: [Recorded],
  rejects: [Faulty],
}) {}

export class Sample extends Domain.Command("Sample", {
  input: { id: Schema.String, readings: Schema.Array(Reading) },
  events: [Recorded],
  rejects: [Faulty],
}) {}

export class Skip extends Domain.Command("Skip", {
  input: { id: Schema.String },
  events: [Skipped],
}) {}

export class Pad extends Domain.Command("Pad", {
  input: {
    id: Schema.String,
    count: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
  },
  events: [Skipped],
}) {}

/** A reading no sensor gives. */
class OutOfRange extends Data.TaggedError("OutOfRange")<{ readonly reading: number }> {}

/** A reading, once it is checked: one at freezing is a sensor that has stopped. */
const checked = (reading: number) =>
  reading === 0 ? Effect.fail(new OutOfRange({ reading })) : Effect.succeed(reading);

/**
 * The readings of a sensor, kept as a count, a sum and a peak. Its commands
 * work through the readings as streams: filtered, checked one at a time,
 * cut short, and run to a value.
 */
export class Feed extends Domain.Aggregate("Feed", {
  id: Schema.String,
  state: Schema.Struct({
    count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    sum: Schema.Int,
    peak: Schema.Int,
    skipped: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  initial: { count: 0, sum: 0, peak: 0, skipped: 0 },
  invariants: {
    ThePeakIsNeverBelowZero: (feed) => feed.peak >= 0,
    TheSumIsNeverAboveThePeakOfEach: (feed) => feed.sum <= feed.peak * feed.count,
  },
  transitions: {
    ACommandRecordsAtMostABatch: ({ before, after }) => after.count - before.count <= BATCH,
    ThePeakOnlyRises: ({ before, after }) => after.peak >= before.peak,
  },
  commands: [Record, Sample, Skip, Pad],
  keyOf: (command) => command.id,
  decide: {
    // Every reading above zero is checked, and the first batch of them is kept.
    Record: Effect.fn(function* (feed, command) {
      const kept = yield* Stream.fromIterable(command.readings).pipe(
        Stream.filter((reading) => reading >= 0),
        Stream.mapEffect(checked),
        Stream.take(BATCH),
        Stream.runCollect,
        Effect.catchTag("OutOfRange", (error) =>
          Effect.fail(new Faulty({ reading: error.reading })),
        ),
      );
      const sum = yield* Stream.fromIterable(kept).pipe(
        Stream.runFold(
          () => 0,
          (a, b) => a + b,
        ),
      );
      const peak = yield* Stream.fromIterable(kept).pipe(
        Stream.scan(
          () => feed.peak,
          (highest, reading) => Math.max(highest, reading),
        ),
        Stream.runLast,
      );
      return kept.length === 0
        ? []
        : [
            new Recorded({
              count: kept.length,
              sum,
              peak: Option.getOrElse(peak, () => feed.peak),
            }),
          ];
    }),
    // Only the first reading is looked at: the ones after it are never checked.
    Sample: Effect.fn(function* (feed, command) {
      const first = yield* Stream.fromIterable(command.readings).pipe(
        Stream.mapEffect(checked),
        Stream.runHead,
        Effect.mapError((error) => new Faulty({ reading: error.reading })),
      );
      return Option.match(first, {
        onNone: () => [],
        onSome: (reading) =>
          reading < 0
            ? []
            : [new Recorded({ count: 1, sum: reading, peak: Math.max(feed.peak, reading) })],
      });
    }),
    // A stream that never ends, cut to three.
    Skip: Effect.fn(function* () {
      const count = yield* Stream.iterate(1, (n) => n + 1).pipe(Stream.take(3), Stream.runCount);
      return [new Skipped({ count })];
    }),
    // Cut to a count the command gives: how many items that is, is not a thing the prover sees.
    Pad: Effect.fn(function* (_feed, command) {
      const count = yield* Stream.iterate(1, (n) => n + 1).pipe(
        Stream.take(command.count),
        Stream.runCount,
      );
      return [new Skipped({ count })];
    }),
  },
  evolve: {
    Recorded: (feed, event) => ({
      ...feed,
      count: feed.count + event.count,
      sum: feed.sum + event.sum,
      peak: event.peak,
    }),
    Skipped: (feed, event) => ({ ...feed, skipped: feed.skipped + event.count }),
  },
}) {}
