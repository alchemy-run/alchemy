import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

// Decisions that never read their state, and still have many ways through
// them as the code is written: twelve tests of one field, of which at most
// one is true, and twelve optional fields read only for a default.

export class Noted extends Domain.Event("Noted", { text: Schema.String }) {}

export class ByKind extends Domain.Command("ByKind", {
  input: { pad: Schema.String, other: Schema.String, kind: Schema.String },
  events: [Noted],
}) {}

export class ByField extends Domain.Command("ByField", {
  input: {
    pad: Schema.String,
    other: Schema.String,
    f1: Schema.optionalKey(Schema.String),
    f2: Schema.optionalKey(Schema.String),
    f3: Schema.optionalKey(Schema.String),
    f4: Schema.optionalKey(Schema.String),
    f5: Schema.optionalKey(Schema.String),
    f6: Schema.optionalKey(Schema.String),
    f7: Schema.optionalKey(Schema.String),
    f8: Schema.optionalKey(Schema.String),
    f9: Schema.optionalKey(Schema.String),
    f10: Schema.optionalKey(Schema.String),
    f11: Schema.optionalKey(Schema.String),
    f12: Schema.optionalKey(Schema.String),
  },
  events: [Noted],
}) {}

export class Pad extends Domain.Aggregate("Pad", {
  id: Schema.String,
  state: Schema.Struct({ text: Schema.String }),
  initial: { text: "" },
  events: [Noted],
  evolve: { Noted: (_pad, e) => ({ text: e.text }) },
}) {}

/** `kind` is one string: thirteen combinations of the twelve tests can occur, of 4096. */
export class NoteByKind extends Domain.Decision(ByKind, {
  reads: { pad: Pad, other: Pad },
  keyOf: (cmd) => ({ pad: cmd.pad, other: cmd.other }),
  decide: ({ pad }, cmd) => [
    pad.record(
      new Noted({
        text:
          (cmd.kind === "k1" ? "1" : "") +
          (cmd.kind === "k2" ? "2" : "") +
          (cmd.kind === "k3" ? "3" : "") +
          (cmd.kind === "k4" ? "4" : "") +
          (cmd.kind === "k5" ? "5" : "") +
          (cmd.kind === "k6" ? "6" : "") +
          (cmd.kind === "k7" ? "7" : "") +
          (cmd.kind === "k8" ? "8" : "") +
          (cmd.kind === "k9" ? "9" : "") +
          (cmd.kind === "k10" ? "10" : "") +
          (cmd.kind === "k11" ? "11" : "") +
          (cmd.kind === "k12" ? "12" : ""),
      }),
    ),
  ],
}) {}

/** Each field is there or not, and both ways go to the same code: one text, of twelve parts. */
export class NoteByField extends Domain.Decision(ByField, {
  reads: { pad: Pad, other: Pad },
  keyOf: (cmd) => ({ pad: cmd.pad, other: cmd.other }),
  decide: ({ pad }, cmd) => [
    pad.record(
      new Noted({
        text:
          (cmd.f1 ?? "") +
          (cmd.f2 ?? "") +
          (cmd.f3 ?? "") +
          (cmd.f4 ?? "") +
          (cmd.f5 ?? "") +
          (cmd.f6 ?? "") +
          (cmd.f7 ?? "") +
          (cmd.f8 ?? "") +
          (cmd.f9 ?? "") +
          (cmd.f10 ?? "") +
          (cmd.f11 ?? "") +
          (cmd.f12 ?? ""),
      }),
    ),
  ],
}) {}
