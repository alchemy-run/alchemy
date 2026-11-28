import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import { Ticket, TicketOpened } from "../shared/Ticket.aggregate.ts";
import { Helper } from "./Helper.process.ts";

/** An opened ticket is handed to its Helper session. */
export class Handover extends Domain.Policy("Handover", { from: Ticket, on: [TicketOpened] }) {}

export const HandoverLive = Handover.toLayer(
  Effect.gen(function* () {
    const helper = yield* Helper;
    return Effect.fn(function* ({ source, event }) {
      yield* helper.get(source.id).send(event.subject, { requestId: "start" }).pipe(Effect.orDie);
    });
  }),
);
