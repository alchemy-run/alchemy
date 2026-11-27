import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

// A command whose input has a field it may leave out, and a choice of kind.

export class Written extends Domain.Event("Written", { size: Schema.Int }) {}

const Body = Schema.Union([
  Schema.TaggedStruct("Text", { text: Schema.String }),
  Schema.TaggedStruct("Blank", {}),
]);

const input = { target: Schema.String, title: Schema.optionalKey(Schema.String), body: Body };
export class Write extends Domain.Command("Write", { input, events: [Written] }) {}
export class Retitle extends Domain.Command("Retitle", { input, events: [Written] }) {}
export class Touch extends Domain.Command("Touch", { input, events: [Written] }) {}

export class Memo extends Domain.Aggregate("Memo", {
  id: Schema.String,
  state: Schema.Struct({ size: Schema.Int }),
  initial: { size: 1 },
  commands: [Write, Retitle, Touch],
  keyOf: (command) => command.target,
  decide: {
    // A title left out counts for nothing: the size is then zero.
    Write: (_memo, c) => [new Written({ size: c.title === undefined ? 0 : c.title.length + 1 })],
    // The body is one kind or the other, and each is counted.
    Retitle: (_memo, c) => [
      new Written({ size: c.body._tag === "Text" ? c.body.text.length + 1 : 1 }),
    ],
    // Reads neither: no choice is made for it.
    Touch: (memo) => [new Written({ size: memo.size })],
  },
  events: [Written],
  evolve: { Written: (_memo, e) => ({ size: e.size }) },
  invariants: { NeverEmpty: (memo) => memo.size >= 1 },
}) {}
