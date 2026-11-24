import * as Domain from "@alchemy.run/domain";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// Commands that read a field only for the value it holds, or a default. Both
// ways go to the same code, so each is one path: whether the field holds a
// value is an input, and the label or the size is one value that depends on it.

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export class Set extends Domain.Event("Set", { label: Schema.String, size: Schema.Int }) {}

const input = {
  target: Schema.String,
  /** There, or left out. */
  name: Schema.optionalKey(Schema.String),
  /** There, left out, or `undefined`. */
  count: Schema.optional(Count),
  /** A number, or `null`. */
  limit: Schema.NullOr(Count),
  note: Schema.Option(Schema.String),
};
const command = { input, events: [Set] };

export class Name extends Domain.Command("Name", command) {}
export class Rename extends Domain.Command("Rename", command) {}
export class Count_ extends Domain.Command("Count", command) {}
export class CountDown extends Domain.Command("CountDown", command) {}
export class Limit extends Domain.Command("Limit", command) {}
export class Note extends Domain.Command("Note", command) {}
export class NotePiped extends Domain.Command("NotePiped", command) {}
export class NoteThrough extends Domain.Command("NoteThrough", command) {}
export class NoteMatched extends Domain.Command("NoteMatched", command) {}
export class NameTwice extends Domain.Command("NameTwice", command) {}
export class NameOrNote extends Domain.Command("NameOrNote", command) {}
export class NameHeld extends Domain.Command("NameHeld", command) {}
export class NameTaken extends Domain.Command("NameTaken", command) {}
export class NameAssigned extends Domain.Command("NameAssigned", command) {}
export class CountPlus extends Domain.Command("CountPlus", command) {}
export class NoteMarked extends Domain.Command("NoteMarked", command) {}

export class Defaults extends Domain.Aggregate("Defaults", {
  id: Schema.String,
  state: Schema.Struct({ label: Schema.String, size: Schema.Int }),
  initial: { label: "new", size: 0 },
  commands: [
    Name,
    Rename,
    Count_,
    CountDown,
    Limit,
    Note,
    NotePiped,
    NoteThrough,
    NoteMatched,
    NameTwice,
    NameOrNote,
    NameHeld,
    NameTaken,
    NameAssigned,
    CountPlus,
    NoteMarked,
  ],
  keyOf: (command) => command.target,
  decide: {
    // A name or the default, and then a mark: never empty.
    Name: (_state, c) => [new Set({ label: (c.name ?? "anon") + "!", size: 0 })],
    // A name that is there may be empty.
    Rename: (_state, c) => [new Set({ label: c.name ?? "anon", size: 0 })],
    // The schema's check holds of a count that is there.
    Count: (_state, c) => [new Set({ label: "count", size: c.count ?? 0 })],
    // A count of zero that is there goes below zero: the default does not.
    CountDown: (_state, c) => [new Set({ label: "count", size: (c.count ?? 1) - 1 })],
    // `null` is nothing, as a field left out is.
    Limit: (_state, c) => [new Set({ label: "limit", size: c.limit ?? 0 })],
    Note: (_state, c) => [
      new Set({ label: Option.getOrElse(c.note, () => "none") + ".", size: 0 }),
    ],
    // A note that is there may be empty.
    NotePiped: (_state, c) => [
      new Set({ label: c.note.pipe(Option.getOrElse(() => "none")), size: 0 }),
    ],
    NoteThrough: (_state, c) => [
      new Set({
        label: pipe(
          c.note,
          Option.getOrElse(() => "none"),
          (text) => text + ".",
        ),
        size: 0,
      }),
    ],
    NoteMatched: (_state, c) => [
      new Set({
        label: Option.match(c.note, { onNone: () => "none", onSome: (text) => text }),
        size: 0,
      }),
    ],
    // Read for a default, and then looked at: the second read is a choice, and agrees with the first.
    NameTwice: (_state, c) => [
      new Set({ label: (c.name ?? "a") + (c.name === undefined ? "b" : "c"), size: 0 }),
    ],
    // The default is another field's value: that one is chosen, and this one is not.
    NameOrNote: (_state, c) => [
      new Set({ label: (c.name ?? Option.getOrElse(c.note, () => "none")) + "!", size: 0 }),
    ],
    // A name the field is given is the field, until the code looks at it.
    NameHeld: (_state, c) => {
      const name = c.name;
      return [new Set({ label: (name ?? "anon") + "!", size: 0 })];
    },
    NameTaken: (_state, c) => {
      const { name, note } = c;
      return [
        new Set({ label: (name ?? "anon") + Option.getOrElse(note, () => "none") + "!", size: 0 }),
      ];
    },
    NameAssigned: (_state, c) => {
      let name = c.name;
      name ??= "anon";
      return [new Set({ label: name + "!", size: 0 })];
    },
    // A default, and a case, that is computed: a sum, with no test in it.
    CountPlus: (_state, c) => [new Set({ label: "count", size: c.count ?? 1 + 1 })],
    NoteMarked: (_state, c) => [
      new Set({
        label: Option.match(c.note, { onNone: () => "none", onSome: (text) => text + "!" }),
        size: 0,
      }),
    ],
  },
  events: [Set],
  evolve: { Set: (_state, e) => ({ label: e.label, size: e.size }) },
  invariants: {
    Labelled: (state) => state.label !== "",
    Sized: (state) => state.size >= 0,
  },
}) {}
