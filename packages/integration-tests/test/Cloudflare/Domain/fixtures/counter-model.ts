import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Schema from "effect/Schema";

const CounterId = Schema.String.pipe(Schema.brand("CounterId"));

class Incremented extends Domain.Event("Incremented", { by: Schema.Int }) {}

class Increment extends Domain.Command("Increment", {
  target: CounterId,
  input: { by: Schema.Int },
  events: [Incremented],
}) {}

class Counter extends Domain.Aggregate("Counter", {
  id: CounterId,
  state: Schema.Struct({ total: Schema.Int }),
  initial: { total: 0 },
  commands: [Increment],
  decide: {
    Increment: (_, command) => [new Incremented({ by: command.by })],
  },
  evolve: {
    Incremented: (state, event) => ({ total: state.total + event.by }),
  },
}) {}

export class Counters extends Domain.Model("Counters", {
  aggregates: [Counter],
}) {}

/** Serves `/increment/:id` and `/state/:id` for a counter. */
export const serve = Effect.gen(function* () {
  const counters = yield* Counter;
  return {
    fetch: Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      const [, action, id] = new URL(request.url, "http://localhost").pathname.split("/");
      const counter = CounterId.make(id ?? "c-1");
      if (action === "increment") {
        yield* counters.send(counter, new Increment({ by: 2 })).pipe(Effect.orDie);
      }
      return yield* HttpServerResponse.json(yield* counters.state(counter));
    }),
  };
});
