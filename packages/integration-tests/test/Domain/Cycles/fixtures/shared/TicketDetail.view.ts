import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Ticket } from "./Ticket.aggregate.ts";

/** A ticket's subject and whether it is open. */
export class TicketDetail extends Domain.View("TicketDetail", {
  from: [Ticket],
  key: Ticket,
  state: Schema.Struct({ subject: Schema.String, open: Schema.Boolean }),
  initial: { subject: "", open: false },
  evolve: {
    TicketOpened: (_, event) => ({ subject: event.subject, open: true }),
    TicketClosed: (state) => ({ ...state, open: false }),
  },
}) {}
