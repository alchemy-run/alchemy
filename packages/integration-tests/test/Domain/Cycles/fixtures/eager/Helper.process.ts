import * as AI from "@alchemy.run/ai";
import { Desk } from "./Desk.model.ts";

/** Looks after one ticket. One session per ticket. */
export class Helper extends AI.Process<Helper>()("Helper", {}) {}

/** No thunks: the prose mentions `Desk.X`, the model and the view list members directly. */
export const HelperLive = Helper.toLayer({ description: "Close one ticket." })`
  Read the ticket with ${Desk.TicketDetail}, then close it with ${Desk.CloseTicket}.
`;
