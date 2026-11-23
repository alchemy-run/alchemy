import * as Domain from "@alchemy.run/domain";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** How long a renewal adds. */
const TERM = Duration.days(30);

export class Granted extends Domain.Event("Granted", { until: Schema.DateTimeUtc }) {}

export class Renewed extends Domain.Event("Renewed", { until: Schema.DateTimeUtc }) {}

export class Cut extends Domain.Event("Cut", { until: Schema.DateTimeUtc }) {}

export class Lapsed extends Domain.Rejection("Lapsed", {}) {}

const Days = Schema.Int.check(Schema.isGreaterThan(0));

export class Grant extends Domain.Command("Grant", {
  input: { id: Schema.String, days: Days },
  events: [Granted],
}) {}

export class Renew extends Domain.Command("Renew", {
  input: { id: Schema.String },
  events: [Renewed],
  rejects: [Lapsed],
}) {}

export class Trim extends Domain.Command("Trim", {
  input: { id: Schema.String },
  events: [Cut],
}) {}

/**
 * A lease that runs until a time. Its rules are about times: they are
 * written with `DateTime` and `Duration`, and two of its commands read the
 * clock instead of the `now` they are given.
 */
export class Lease extends Domain.Aggregate("Lease", {
  id: Schema.String,
  state: Schema.Struct({ until: Schema.DateTimeUtc }),
  initial: { until: DateTime.makeUnsafe(0) },
  transitions: {
    TheLeaseNeverShortens: ({ before, after }) =>
      DateTime.isGreaterThanOrEqualTo(after.until, before.until),
    ARenewalAddsATerm: ({ before, after, command }) =>
      command._tag !== "Renew" ||
      Duration.equals(DateTime.distance(before.until, after.until), TERM),
  },
  commands: [Grant, Renew, Trim],
  keyOf: (command) => command.id,
  decide: {
    // A lease still running is left as it is: a new one starts now.
    Grant: (lease, command, { now }) =>
      DateTime.isGreaterThan(lease.until, now)
        ? []
        : [Granted.make({ until: DateTime.add(now, { days: command.days }) })],
    // The clock, as a time: the time the command is handled at.
    Renew: Effect.fn(function* (lease) {
      const now = yield* DateTime.now;
      if (DateTime.isLessThanOrEqualTo(lease.until, now)) return yield* new Lapsed();
      return [Renewed.make({ until: lease.until.pipe(DateTime.addDuration(TERM)) })];
    }),
    // The clock, as milliseconds. A lease still running loses an hour: the rule is broken.
    Trim: Effect.fn(function* (lease) {
      const millis = yield* Clock.currentTimeMillis;
      return DateTime.toEpochMillis(lease.until) > millis
        ? [Cut.make({ until: DateTime.subtractDuration(lease.until, "1 hour") })]
        : [];
    }),
  },
  evolve: {
    Granted: (_lease, event) => ({ until: event.until }),
    Renewed: (_lease, event) => ({ until: event.until }),
    Cut: (_lease, event) => ({ until: event.until }),
  },
}) {}
