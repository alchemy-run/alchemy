/**
 * Type-level regressions for stories: a `when` step is checked against the
 * model's command of its tag. Compiled, never run.
 */
import * as Domain from "@alchemy.run/domain";
import { Story } from "@alchemy.run/domain/Story";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as Schema from "effect/Schema";

class Operator extends Context.Service<Operator, string>()("Test/Operator") {}
class Session extends RpcMiddleware.Service<Session, { provides: Operator }>()("Session") {}
class Done extends Domain.Event("Done") {}
class Nope extends Domain.Rejection("Nope") {}
class Reset extends Domain.Command("Reset", {
  input: { id: Schema.String },
  middleware: [Session],
  events: [Done],
}) {}
class Counter extends Domain.Aggregate("Counter", {
  id: Schema.String,
  state: Schema.Struct({}),
  initial: {},
  commands: [Reset],
  keyOf: (command) => command.id,
  decide: { Reset: () => [Done.make()] },
  evolve: { Done: (s) => s },
}) {}
class Counters extends Domain.Model("Counters", { aggregates: [Counter] }) {}
const story = Story.make(Counters);
// @ts-expect-error Reset needs Story.provide(Test/Operator) before it
export const a = story(Story.when(Reset.make({ id: "c" })));
const provided = Story.provide(Operator, "sam");
const reset = Story.when(Reset.make({ id: "c" }));
// @ts-expect-error Reset does not reject with Nope
export const b = story(provided, reset, Story.rejected(Nope.make()));
export const c = story(provided, reset, Story.then(Counter.ref("c"), Done.make()));
// `provideWith` satisfies a `when`'s need for the service, as `provide` does.
export const d = story(
  Story.provideWith(Operator, ({ command }) => Effect.succeed(Option.some(command._tag))),
  reset,
);
// @ts-expect-error what `provideWith` makes is the service's own type
export const e = Story.provideWith(Operator, () => Effect.succeed(Option.some(1)));
