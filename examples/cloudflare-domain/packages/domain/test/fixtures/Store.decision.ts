import * as Domain from "@alchemy.run/domain";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// A state that holds records with optional fields and a choice of kind, read
// by decisions that look at little of it. A field no code reads costs no
// path: the run chooses one only when the code first reads it.

const Kind = Schema.Union([
  Schema.TaggedStruct("Good", { grams: Schema.Int }),
  Schema.TaggedStruct("Service", { minutes: Schema.Int }),
  Schema.TaggedStruct("Gift", {}),
]);

const Item = Schema.Struct({
  id: Schema.String,
  a: Schema.optionalKey(Schema.String),
  b: Schema.optionalKey(Schema.String),
  c: Schema.optionalKey(Schema.String),
  d: Schema.optionalKey(Schema.String),
  e: Schema.optionalKey(Schema.String),
  f: Schema.optionalKey(Schema.String),
  note: Schema.Option(Schema.String),
  kind: Kind,
});

export class ItemAdded extends Domain.Event("ItemAdded", { item: Item }) {}
export class Full extends Domain.Rejection("Full") {}
export class Unknown extends Domain.Rejection("Unknown") {}

const input = { from: Schema.String, to: Schema.String, id: Schema.String };
const outcomes = { events: [ItemAdded], rejects: [Full, Unknown] };

export class AddItem extends Domain.Command("AddItem", { input, ...outcomes }) {}
export class CopyItem extends Domain.Command("CopyItem", { input, ...outcomes }) {}
export class CopyNoted extends Domain.Command("CopyNoted", { input, ...outcomes }) {}
export class CopyLabelled extends Domain.Command("CopyLabelled", { input, ...outcomes }) {}
export class DropLabel extends Domain.Command("DropLabel", { input, ...outcomes }) {}

export class Store extends Domain.Aggregate("Store", {
  id: Schema.String,
  state: Schema.Struct({ items: Schema.Array(Item) }),
  initial: { items: [] },
  events: [ItemAdded],
  evolve: { ItemAdded: (store, e) => ({ items: [...store.items, e.item] }) },
  invariants: {
    // Reads one optional field of each item: the others are never chosen.
    NoEmptyLabel: (store) => store.items.every((item) => item.a !== ""),
  },
}) {}

const fresh = (id: string) => ({ id, note: Option.none(), kind: { _tag: "Gift" as const } });

/** Reads only how many items two stores hold. */
export class Add extends Domain.Decision(AddItem, {
  reads: { from: Store, to: Store },
  keyOf: (cmd) => ({ from: cmd.from, to: cmd.to }),
  decide: ({ from, to }, cmd) =>
    from.state.items.length + to.state.items.length >= 10
      ? new Full()
      : [to.record(new ItemAdded({ item: fresh(cmd.id) }))],
  transitions: {
    ToNeverShrinks: ({ before, after }) => after.to.items.length >= before.to.items.length,
  },
}) {}

/** Finds an item by its id and records it whole: none of its other fields is read. */
export class Copy extends Domain.Decision(CopyItem, {
  reads: { from: Store, to: Store },
  keyOf: (cmd) => ({ from: cmd.from, to: cmd.to }),
  decide: ({ from, to }, cmd) => {
    const found = from.state.items.find((item) => item.id === cmd.id);
    return found === undefined ? new Unknown() : [to.record(new ItemAdded({ item: found }))];
  },
  transitions: {
    ToGrowsByOne: ({ before, after }) =>
      after.to.items.length === before.to.items.length + 1 ||
      after.to.items.length === before.to.items.length,
  },
}) {}

/** Reads the kind of the item it copies, and its note: each is chosen where it is read. */
export class CopyGoods extends Domain.Decision(CopyNoted, {
  reads: { from: Store, to: Store },
  keyOf: (cmd) => ({ from: cmd.from, to: cmd.to }),
  decide: ({ from, to }, cmd) => {
    const found = from.state.items.find((item) => item.id === cmd.id);
    if (found === undefined || found.kind._tag !== "Good" || found.kind.grams > 500)
      return new Unknown();
    return [to.record(new ItemAdded({ item: { ...found, id: `${found.id}-copy` } }))];
  },
  transitions: {
    OnlyLightGoodsAreCopied: ({ before, after }) =>
      after.to.items
        .slice(before.to.items.length)
        .every((item) => item.kind._tag === "Good" && item.kind.grams <= 500),
  },
}) {}

/** Copies an item with a label it gives it, whatever the item's own was. */
export class Label extends Domain.Decision(CopyLabelled, {
  reads: { from: Store, to: Store },
  keyOf: (cmd) => ({ from: cmd.from, to: cmd.to }),
  decide: ({ from, to }, cmd) => {
    const found = from.state.items.find((item) => item.id === cmd.id);
    return found === undefined
      ? new Unknown()
      : [to.record(new ItemAdded({ item: { ...found, a: `label ${cmd.id}` } }))];
  },
}) {}

/** Copies an item with the label it has: an empty one breaks the rule of the store it lands in. */
export class Relabel extends Domain.Decision(DropLabel, {
  reads: { from: Store, to: Store },
  keyOf: (cmd) => ({ from: cmd.from, to: cmd.to }),
  decide: ({ from, to }, cmd) => {
    const found = from.state.items.find((item) => item.id === cmd.id);
    return found === undefined
      ? new Unknown()
      : [to.record(new ItemAdded({ item: { ...found, a: found.b ?? "" } }))];
  },
}) {}
