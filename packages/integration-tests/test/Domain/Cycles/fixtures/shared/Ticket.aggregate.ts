import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

export class TicketOpened extends Domain.Event("TicketOpened", { subject: Schema.String }) {}
export class TicketClosed extends Domain.Event("TicketClosed", { by: Schema.String }) {}

export class OpenTicket extends Domain.Command("OpenTicket", {
  input: { ticketId: Schema.String, subject: Schema.String },
  events: [TicketOpened],
}) {}

export class CloseTicket extends Domain.Command(
  "CloseTicket",
  { input: { ticketId: Schema.String, by: Schema.String }, events: [TicketClosed] },
  { description: "Close the ticket." },
) {}

/** A ticket: no other member of the desk is imported here. */
export class Ticket extends Domain.Aggregate("Ticket", {
  id: Schema.String,
  state: Schema.Struct({ open: Schema.Boolean }),
  initial: { open: false },
  commands: [OpenTicket, CloseTicket],
  keyOf: (command) => command.ticketId,
  decide: {
    OpenTicket: (_, command) => [new TicketOpened({ subject: command.subject })],
    CloseTicket: (_, command) => [new TicketClosed({ by: command.by })],
  },
  evolve: {
    TicketOpened: () => ({ open: true }),
    TicketClosed: () => ({ open: false }),
  },
}) {}
