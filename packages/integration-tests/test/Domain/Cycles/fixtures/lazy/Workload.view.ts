import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Ticket } from "../shared/Ticket.aggregate.ts";
import { Helper } from "./Helper.process.ts";

/** The one key the workload is kept under. */
export const ALL = "all";

/** How many tickets were opened, and whose Helper is working: it follows a process. */
export class Workload extends Domain.View("Workload", () => ({
  from: [Ticket, Helper],
  key: Schema.String,
  keyOf: { TicketOpened: () => ALL, HelperActivity: () => ALL },
  state: Schema.Struct({ opened: Schema.Number, working: Schema.Array(Schema.String) }),
  initial: { opened: 0, working: [] },
  evolve: {
    TicketOpened: (state) => ({ ...state, opened: state.opened + 1 }),
    HelperActivity: (state, event, { source }) => ({
      ...state,
      working:
        event.status === "working"
          ? [...state.working.filter((id) => id !== source.id), source.id]
          : state.working.filter((id) => id !== source.id),
    }),
  },
})) {}
