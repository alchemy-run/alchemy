import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

export class TicketOpened extends Domain.Event("TicketOpened") {}
export class TicketClosed extends Domain.Event("TicketClosed") {}

export class OpenTicket extends Domain.Command("OpenTicket", {
  target: Schema.String,
  events: [TicketOpened],
  rejects: [Domain.WrongPhase],
}) {}
export class CloseTicket extends Domain.Command("CloseTicket", {
  target: Schema.String,
  events: [TicketClosed],
  rejects: [Domain.WrongPhase],
}) {}

export class Ticket extends Domain.Aggregate("Ticket", {
  id: Schema.String,
  state: Schema.Struct({ phase: Schema.Literals(["new", "open", "closed"]) }),
  initial: { phase: "new" },
  commands: [OpenTicket, CloseTicket],
  decide: {
    OpenTicket: () => [new TicketOpened()],
    CloseTicket: () => [new TicketClosed()],
  },
  evolve: {
    TicketOpened: () => ({ phase: "open" as const }),
    TicketClosed: () => ({ phase: "closed" as const }),
  },
  phases: {
    new: { on: { TicketOpened: "open" } },
    open: { on: { TicketClosed: "closed" } },
    closed: {},
  },
  phaseOf: (s) => s.phase,
  when: { OpenTicket: ["new"], CloseTicket: ["open"] },
}) {}

export class Tickets extends Domain.Model("Tickets", { aggregates: [Ticket] }) {}
