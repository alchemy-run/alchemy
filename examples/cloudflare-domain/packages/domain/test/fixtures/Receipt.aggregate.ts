import * as Domain from "@alchemy.run/domain";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { idOf, isBlank } from "./hash.ts";

export class Printed extends Domain.Event("Printed", { note: Schema.String }) {}

export class Print extends Domain.Command("Print", {
  input: { target: Schema.String, note: Schema.String },
  events: [Printed],
}) {}

/**
 * A receipt printed with a note that says something. Its id is a hash kept
 * twice, it keeps the time it was printed at as text, and one rule reads into
 * the hash.
 */
export class Receipt extends Domain.Aggregate("Receipt", {
  id: Schema.String,
  state: Schema.Struct({
    prints: Schema.Int,
    id: Schema.String,
    copy: Schema.String,
    printedAt: Schema.String,
  }),
  initial: { prints: 0, id: "", copy: "", printedAt: "" },
  commands: [Print],
  keyOf: (command) => command.target,
  invariants: {
    // Two calls of `idOf` on one number are one value: proved without reading `idOf`.
    TheCopyIsTheId: (receipt) => receipt.copy === receipt.id,
    // `Print` does not stop at two, and only a note that is not blank gets there.
    NeverPrintedMoreThanTwice: (receipt) => receipt.prints <= 2,
    // What `idOf` returns is not read, so nothing is known of its length.
    TheIdIsNeverEmpty: (receipt) => receipt.prints === 0 || receipt.id.length > 0,
  },
  decide: {
    Print: (_receipt, command) =>
      isBlank(command.note) ? [] : [new Printed({ note: command.note })],
  },
  evolve: {
    Printed: (receipt, _event, envelope) => ({
      prints: receipt.prints + 1,
      id: idOf(envelope.seq),
      copy: idOf(envelope.seq),
      printedAt: DateTime.formatIso(envelope.at),
    }),
  },
}) {}
