import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as Schema from "effect/Schema";

export class Operator extends Domain.RequestContext<Operator>()(
  "Counter/Operator",
  Schema.Struct({ admin: Schema.Boolean }),
) {}

/** Says who sends a command. It lets anyone in: what an operator may do is up to `decide`. */
export class Desk extends RpcMiddleware.Service<Desk, { provides: Operator }>()("Counter/Desk") {}

export class Counted extends Domain.Event("Counted", { by: Schema.Int }) {}

export class Cleared extends Domain.Event("Cleared", {}) {}

const Positive = Schema.Int.check(Schema.isGreaterThan(0));

export class Count extends Domain.Command("Count", {
  middleware: [Desk],
  input: { id: Schema.String, by: Positive },
  events: [Counted],
}) {}

export class Clear extends Domain.Command("Clear", {
  middleware: [Desk],
  input: { id: Schema.String },
  events: [Cleared],
}) {}

/**
 * A counter whose state is always one its invariant allows, and which still
 * does two things it says it never does: `Clear` takes the count down, and
 * anyone may send it.
 */
export class Counter extends Domain.Aggregate("Counter", {
  id: Schema.String,
  state: Schema.Struct({ count: Schema.Int }),
  initial: { count: 0 },
  invariants: { NotNegative: (counter) => counter.count >= 0 },
  transitions: {
    NeverGoesDown: ({ before, after }) => after.count >= before.count,
    CountsWhatItWasAsked: ({ before, after, command }) =>
      command._tag !== "Count" || after.count === before.count + command.by,
    OnlyAnAdminClears: Effect.fn(function* ({ command }) {
      return command._tag !== "Clear" || (yield* Operator).admin;
    }),
  },
  commands: [Count, Clear],
  keyOf: (cmd) => cmd.id,
  decide: {
    Count: (_, command) => [new Counted({ by: command.by })],
    Clear: (counter) => (counter.count === 0 ? [] : [new Cleared({})]),
  },
  evolve: {
    Counted: (counter, event) => ({ count: counter.count + event.by }),
    Cleared: () => ({ count: 0 }),
  },
}) {}
