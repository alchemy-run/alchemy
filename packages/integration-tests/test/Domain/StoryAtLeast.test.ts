import * as Domain from "@alchemy.run/domain";
import { Story } from "@alchemy.run/domain/Story";
import { describe, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// A policy sends a command, then reads a view `atLeast` that write. The view
// applies the event in a run of its own, which a story queues behind the
// policy's run.

class Added extends Domain.Event("Added", { total: Schema.Number }) {}
class Add extends Domain.Command("Add", { target: Schema.String, events: [Added] }) {}

class Counter extends Domain.Aggregate("Counter", {
  id: Schema.String,
  state: Schema.Struct({ total: Schema.Number }),
  initial: { total: 0 },
  commands: [Add],
  decide: { Add: (counter) => [new Added({ total: counter.total + 1 })] },
  evolve: { Added: (_, e) => ({ total: e.total }) },
}) {}

class Totals extends Domain.View("Totals", {
  from: [Counter],
  key: Counter,
  state: Schema.Struct({ total: Schema.Number }),
  initial: { total: 0 },
  evolve: { Added: (_, e) => ({ total: e.total }) },
}) {}

class Placed extends Domain.Event("Placed") {}
class Counted extends Domain.Event("Counted", { total: Schema.Number }) {}
class Place extends Domain.Command("Place", { target: Schema.String, events: [Placed] }) {}
class RecordCount extends Domain.Command("RecordCount", {
  target: Schema.String,
  input: { total: Schema.Number },
  events: [Counted],
}) {}

class Order extends Domain.Aggregate("Order", {
  id: Schema.String,
  state: Schema.Struct({ counted: Schema.Number }),
  initial: { counted: 0 },
  commands: [Place, RecordCount],
  decide: {
    Place: () => [new Placed()],
    RecordCount: (_, cmd) => [new Counted({ total: cmd.total })],
  },
  evolve: {
    Placed: (order) => order,
    Counted: (_, e) => ({ counted: e.total }),
  },
}) {}

const counter = Counter.ref("orders");

// Counts each order, and records on the order the total the view then shows.
class CountOrders extends Domain.Policy("CountOrders", { from: Order, on: [Placed] }) {}
const CountOrdersLive = CountOrders.toLayer(
  Effect.gen(function* () {
    const counters = yield* Counter;
    const orders = yield* Order;
    const totals = yield* Totals;
    return Effect.fn(function* ({ source }) {
      const receipt = yield* counters.send(counter, new Add());
      const read = yield* totals
        .get(counter, { atLeast: { stream: receipt.stream, version: receipt.version } })
        .pipe(Effect.orDie);
      yield* orders.send(source, new RecordCount({ total: Option.getOrThrow(read).total }));
    });
  }),
);

class Shop extends Domain.Model("Shop", {
  aggregates: [Counter, Order],
  views: [Totals],
  policies: [CountOrders],
}) {}

const story = Story.make(Shop, { layer: CountOrdersLive });
const order = Order.ref("o-1");

describe("Domain Story: a read atLeast a write", { tags: ["unit", "local"] }, () => {
  it.effect(
    "a policy reads a view at least at the write it sent",
    () =>
      story(
        Story.when(order, new Place()),
        Story.then(order, new Placed()),
        Story.then(counter, new Added({ total: 1 })),
        Story.then(order, new Counted({ total: 1 })),
        Story.view(Totals, counter, { total: 1 }),
      ),
    { timeout: 30_000 },
  );
});
