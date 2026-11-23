import * as Domain from "@alchemy.run/domain";
import * as Array from "effect/Array";
import * as Data from "effect/Data";
import * as Equal from "effect/Equal";
import { flow, pipe } from "effect/Function";
import * as Number from "effect/Number";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as String from "effect/String";
import * as Struct from "effect/Struct";

/** The most a line may cost. */
const CEILING = 1_000;

const Line = Schema.Struct({
  sku: Schema.String,
  price: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: CEILING })),
  count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
type Line = typeof Line.Type;

export class Listed extends Domain.Event("Listed", {
  sku: Schema.String,
  price: Schema.Int,
  count: Schema.Int,
}) {}

export class Restocked extends Domain.Event("Restocked", {
  sku: Schema.String,
  price: Schema.Int,
  count: Schema.Int,
}) {}

export class Repriced extends Domain.Event("Repriced", {
  sku: Schema.String,
  price: Schema.Int,
  was: Schema.Int,
  count: Schema.Int,
}) {}

export class Cleared extends Domain.Event("Cleared", { skus: Schema.Array(Schema.String) }) {}

export class BadSku extends Domain.Rejection("BadSku", {}) {}

export class Unknown extends Domain.Rejection("Unknown", {}) {}

export class Stock extends Domain.Command("Stock", {
  input: {
    id: Schema.String,
    sku: Schema.String,
    price: Schema.Int.check(Schema.isGreaterThan(0)),
    count: Schema.Int.check(Schema.isGreaterThan(0)),
  },
  events: [Listed, Restocked],
  rejects: [BadSku],
}) {}

export class Reprice extends Domain.Command("Reprice", {
  input: { id: Schema.String, sku: Schema.String, price: Schema.Int },
  events: [Repriced],
  rejects: [Unknown],
}) {}

export class Clear extends Domain.Command("Clear", {
  input: { id: Schema.String },
  events: [Cleared],
}) {}

/** What stocking a sku comes to: a line of its own, or more of one that is there. */
type Plan = Data.TaggedEnum<{
  New: { readonly price: number };
  More: { readonly line: Line };
}>;
const Plan = Data.taggedEnum<Plan>();

const isSku = String.startsWith("sku-");
const worthOf = (line: Line) => line.price * line.count;
const byPrice = Order.mapInput(Order.Number, (line: Line) => line.price);

/** A price a line may have: one outside the range is brought to its nearest end. */
const priced = flow(Number.clamp({ minimum: 1, maximum: CEILING }), Number.max(1));

/**
 * The lines of a shelf, with what they are worth and the dearest price it
 * has had. Its rules and handlers are written with the library's functions
 * of arrays, numbers, strings and orders.
 */
export class Shelf extends Domain.Aggregate("Shelf", {
  id: Schema.String,
  state: Schema.Struct({
    lines: Schema.Array(Line),
    worth: Schema.Int,
    dearest: Schema.Int,
  }),
  initial: { lines: [], worth: 0, dearest: 0 },
  invariants: {
    TheWorthIsWhatTheLinesAreWorth: (shelf) =>
      shelf.worth === Number.sumAll(Array.map(shelf.lines, worthOf)),
    NoSkuTwice: (shelf) =>
      Array.length(Array.dedupeWith(shelf.lines, (a, b) => a.sku === b.sku)) === shelf.lines.length,
    NothingDearerThanTheDearest: (shelf) =>
      pipe(
        Array.sort(shelf.lines, byPrice),
        Array.last,
        Option.match({ onNone: () => true, onSome: (line) => line.price <= shelf.dearest }),
      ),
    EverySkuIsOne: (shelf) => Array.every(shelf.lines, (line) => isSku(line.sku)),
  },
  transitions: {
    AClearChangesNoPrice: ({ before, after, command }) =>
      command._tag !== "Clear" ||
      Equal.equals(
        Struct.pick(after, ["worth", "dearest"]),
        Struct.pick(before, ["worth", "dearest"]),
      ),
  },
  commands: [Stock, Reprice, Clear],
  keyOf: (command) => command.id,
  decide: {
    Stock: (shelf, command) => {
      if (Predicate.not(isSku)(command.sku)) return new BadSku();
      const plan = pipe(
        Array.findFirst(shelf.lines, (line) => line.sku === command.sku),
        Option.match({
          onNone: () => Plan.New({ price: priced(command.price) }),
          onSome: (line) => Plan.More({ line }),
        }),
      );
      return Plan.$match(plan, {
        New: ({ price }) => [new Listed({ sku: command.sku, price, count: command.count })],
        More: ({ line }) => [
          new Restocked({ sku: line.sku, price: line.price, count: command.count }),
        ],
      });
    },
    Reprice: (shelf, command) =>
      pipe(
        shelf.lines,
        Array.findFirst((line) => line.sku === command.sku),
        Option.match({
          onNone: () => new Unknown(),
          onSome: (line) => [
            new Repriced({
              sku: line.sku,
              price: priced(command.price),
              was: line.price,
              count: line.count,
            }),
          ],
        }),
      ),
    // The lines with nothing left, grouped apart from the rest.
    Clear: (shelf) => {
      const { gone = [] } = Array.groupBy(shelf.lines, (line) =>
        line.count > 0 ? "kept" : "gone",
      );
      return Array.isArrayNonEmpty(gone)
        ? [new Cleared({ skus: Array.map(gone, Struct.get("sku")) })]
        : [];
    },
  },
  evolve: {
    Listed: (shelf, event) => ({
      lines: Array.append(shelf.lines, { sku: event.sku, price: event.price, count: event.count }),
      worth: shelf.worth + event.price * event.count,
      dearest: Order.max(Order.Number)(shelf.dearest, event.price),
    }),
    Restocked: (shelf, event) => ({
      ...shelf,
      lines: Array.map(shelf.lines, (line) =>
        line.sku === event.sku
          ? Struct.evolve(line, { count: (count) => count + event.count })
          : line,
      ),
      worth: shelf.worth + event.price * event.count,
    }),
    Repriced: (shelf, event) => ({
      lines: Array.map(shelf.lines, (line) =>
        line.sku === event.sku ? { ...line, price: event.price } : line,
      ),
      worth: shelf.worth + (event.price - event.was) * event.count,
      dearest: Number.max(shelf.dearest, event.price),
    }),
    Cleared: (shelf, event) => ({
      ...shelf,
      lines: Array.filter(shelf.lines, (line) => !Array.contains(event.skus, line.sku)),
    }),
  },
}) {}
