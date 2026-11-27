import * as Domain from "@alchemy.run/domain";
import { canClose, MAX_RUNS } from "@bank/rules/Ticket";
import * as Schema from "effect/Schema";
import { idOf } from "./hash.ts";

export class Started extends Domain.Event("Started", {}) {}

export class Closed extends Domain.Event("Closed", {}) {}

export class Start extends Domain.Command("Start", {
  input: { target: Schema.String },
  events: [Started],
}) {}

export class Close extends Domain.Command("Close", {
  input: { target: Schema.String },
  events: [Closed],
}) {}

/**
 * A ticket whose runs are named by a hash, which the prover does not read.
 * Its events are built with `make`, and its rule for closing comes from a
 * package of its own.
 */
export class Ticket extends Domain.Aggregate("Ticket", {
  id: Schema.String,
  state: Schema.Struct({ open: Schema.Boolean, runs: Schema.Int, lastRun: Schema.String }),
  initial: { open: true, runs: 0, lastRun: "" },
  commands: [Start, Close],
  keyOf: (command) => command.target,
  invariants: {
    RunsAreCounted: (ticket) => ticket.runs >= 0,
  },
  decide: {
    Start: (ticket) => (ticket.open ? [Started.make({})] : []),
    Close: (ticket) => (canClose(ticket) && ticket.runs <= MAX_RUNS ? [Closed.make({})] : []),
  },
  evolve: {
    Started: (ticket, _event, envelope) => ({
      ...ticket,
      runs: ticket.runs + 1,
      lastRun: idOf(envelope.seq),
    }),
    Closed: (ticket) => ({ ...ticket, open: false }),
  },
  transitions: {
    AClosedTicketStaysClosed: ({ before, after }) => before.open || !after.open,
  },
}) {}
