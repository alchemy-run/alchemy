import * as Domain from "@alchemy.run/domain";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class Pushed extends Domain.Event("Pushed", { due: Schema.DateTimeUtc }) {}

export class Push extends Domain.Command("Push", {
  input: { id: Schema.String },
  events: [Pushed],
}) {}

export class Hold extends Domain.Command("Hold", {
  input: { id: Schema.String },
  events: [Pushed],
}) {}

/**
 * A due date, with two things the prover does not read: a month, which is
 * not one length, and the clock in a rule, which is not the time of any
 * command.
 */
export class Late extends Domain.Aggregate("Late", {
  id: Schema.String,
  state: Schema.Struct({ due: Schema.DateTimeUtc }),
  initial: { due: DateTime.makeUnsafe(0) },
  transitions: {
    TheDueDateIsAhead: Effect.fn(function* ({ after }) {
      return DateTime.isGreaterThanOrEqualTo(after.due, yield* DateTime.now);
    }),
  },
  commands: [Push, Hold],
  keyOf: (command) => command.id,
  decide: {
    Push: (late) => [Pushed.make({ due: DateTime.add(late.due, { months: 1 }) })],
    Hold: (late) => [Pushed.make({ due: late.due })],
  },
  evolve: {
    Pushed: (_late, event) => ({ due: event.due }),
  },
}) {}
