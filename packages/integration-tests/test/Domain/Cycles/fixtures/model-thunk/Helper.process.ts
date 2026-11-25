import * as AI from "@alchemy.run/ai";
import { Desk } from "./Desk.model.ts";

/** Looks after one ticket. One session per ticket. */
export class Helper extends AI.Process<Helper>()("Helper", {}) {}

/** The prose and the model are lazy; the view lists the process directly. */
export const HelperLive = Helper.toLayer({ description: "Close one ticket." })`
  Read the ticket with ${() => Desk.TicketDetail}, then close it with ${() => Desk.CloseTicket}.
`;
