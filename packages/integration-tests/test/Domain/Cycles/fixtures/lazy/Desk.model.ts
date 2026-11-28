import * as Domain from "@alchemy.run/domain";
import { Ticket } from "../shared/Ticket.aggregate.ts";
import { TicketDetail } from "../shared/TicketDetail.view.ts";
import { Handover } from "./Handover.policy.ts";

/** A help desk: tickets, each handed to a Helper session that closes it. */
export class Desk extends Domain.Model("Desk", () => ({
  aggregates: [Ticket],
  views: [TicketDetail],
  policies: [Handover],
})) {}
