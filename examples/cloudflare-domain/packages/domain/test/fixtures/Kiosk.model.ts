import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

export class Stocked extends Domain.Event("Stocked", {}) {}

export class Sold extends Domain.Event("Sold", {}) {}

export class Empty extends Domain.Rejection("Empty", {}) {}

export class Stock extends Domain.Command("Stock", {
  input: { id: Schema.String },
  events: [Stocked],
}) {}

export class Sell extends Domain.Command("Sell", {
  input: { id: Schema.String },
  events: [Sold],
  rejects: [Empty],
}) {}

const definition = {
  id: Schema.String,
  state: Schema.Struct({ stock: Schema.Int, sold: Schema.Int }),
  initial: { stock: 0, sold: 0 },
  commands: [Stock, Sell],
} as const;

/** A shelf that is stocked one item at a time, and sells what it has. */
export class Shelf extends Domain.Aggregate("Shelf", {
  ...definition,
  keyOf: (cmd) => cmd.id,
  invariants: {
    NeverBelowZero: (shelf) => shelf.stock >= 0,
  },
  decide: {
    Stock: () => [new Stocked({})],
    Sell: (shelf) => (shelf.stock > 0 ? [new Sold({})] : new Empty()),
  },
  evolve: {
    Stocked: (shelf) => ({ ...shelf, stock: shelf.stock + 1 }),
    Sold: (shelf) => ({ stock: shelf.stock - 1, sold: shelf.sold + 1 }),
  },
}) {}

/** A kiosk says what it must be able to do: sell something. */
export class Kiosk extends Domain.Model("Kiosk", {
  aggregates: [Shelf],
  sometimes: {
    SomethingIsSold: (kiosk) => kiosk.Shelf.some((shelf) => shelf.state.sold > 0),
  },
}) {}

export class KioskApi extends Domain.Api("KioskApi", {
  model: Kiosk,
  commands: ["Stock", "Sell"],
  views: [],
  streams: [],
  queries: [],
}) {}

/**
 * The same shelf, which sells only once it has sold. From a shelf that has,
 * `Sell` records a sale, so the command is not one that never does anything.
 * No shelf gets there.
 */
export class Bare extends Domain.Aggregate("Bare", {
  ...definition,
  keyOf: (cmd) => cmd.id,
  invariants: {
    NeverBelowZero: (shelf) => shelf.stock >= 0,
  },
  decide: {
    Stock: () => [new Stocked({})],
    Sell: (shelf) => (shelf.stock > 0 && shelf.sold > 0 ? [new Sold({})] : new Empty()),
  },
  evolve: {
    Stocked: (shelf) => ({ ...shelf, stock: shelf.stock + 1 }),
    Sold: (shelf) => ({ stock: shelf.stock - 1, sold: shelf.sold + 1 }),
  },
}) {}

/** It keeps every rule a kiosk has, and every command of it can do something: it never sells. */
export class Shut extends Domain.Model("Shut", {
  aggregates: [Bare],
  sometimes: {
    SomethingIsSold: (shut) => shut.Bare.some((shelf) => shelf.state.sold > 0),
  },
}) {}

export class ShutApi extends Domain.Api("ShutApi", {
  model: Shut,
  commands: ["Stock", "Sell"],
  views: [],
  streams: [],
  queries: [],
}) {}
