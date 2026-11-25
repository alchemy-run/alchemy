import * as Domain from "@alchemy.run/domain";
import { Ticket } from "../shared/Ticket.aggregate.ts";
import { TicketDetail } from "../shared/TicketDetail.view.ts";
import { Handover } from "./Handover.policy.ts";
import { Helper } from "./Helper.process.ts";
import { Workload } from "./Workload.view.ts";

/** A help desk: tickets, and a Helper process that closes each. */
export class Desk extends Domain.Model("Desk", () => ({
  aggregates: [Ticket],
  views: [TicketDetail, Workload],
  policies: [Handover],
  processes: [Helper],
})) {}
