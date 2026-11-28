/**
 * What the hosting suite runs on every platform: a help desk, the Helper
 * process its policy hands each ticket to, and the HTTP routes a front
 * serves over both. The Helper is played by code, so the suite needs no
 * model: it closes its ticket through the desk, as a session's tool would.
 *
 * - `/ready` answers once the front serves
 * - `/open/:id?subject=s` sends `OpenTicket`, which the desk's policy hands to the ticket's session
 * - `/ticket/:id` reads the ticket
 * - `/ask/:key?text=t` asks a session and waits for its answer
 * - `/session/:key` reads where a session stands and its transcript, from outside it
 */
import * as AI from "@alchemy.run/ai";
import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Schema from "effect/Schema";

export class TicketOpened extends Domain.Event("TicketOpened", { subject: Schema.String }) {}
export class TicketClosed extends Domain.Event("TicketClosed", { by: Schema.String }) {}

export class OpenTicket extends Domain.Command("OpenTicket", {
  input: { ticketId: Schema.String, subject: Schema.String },
  events: [TicketOpened],
  rejects: [],
}) {}

export class CloseTicket extends Domain.Command("CloseTicket", {
  input: { ticketId: Schema.String, by: Schema.String },
  events: [TicketClosed],
  rejects: [],
}) {}

export class Ticket extends Domain.Aggregate("Ticket", {
  id: Schema.String,
  state: Schema.Struct({ open: Schema.Boolean, closedBy: Schema.NullOr(Schema.String) }),
  initial: { open: false, closedBy: null },
  commands: [OpenTicket, CloseTicket],
  keyOf: (command) => command.ticketId,
  decide: {
    OpenTicket: (_, command) => [new TicketOpened({ subject: command.subject })],
    CloseTicket: (_, command) => [new TicketClosed({ by: command.by })],
  },
  evolve: {
    TicketOpened: (ticket) => ({ ...ticket, open: true }),
    TicketClosed: (_, event) => ({ open: false, closedBy: event.by }),
  },
}) {}

/** Looks after one ticket. One session per ticket. */
export class Helper extends AI.Process<Helper>()("Helper", {}) {}

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

export class Desk extends Domain.Model("Desk", {
  aggregates: [Ticket],
  policies: [Handover],
}) {}

/** A Helper played by code: it closes its ticket through the desk, and says so. */
export const HelperPlayed = AI.scripted(
  Helper,
  Effect.gen(function* () {
    const tickets = yield* Ticket;
    return Effect.fn(function* ({ key, text }: AI.Turn) {
      yield* tickets.send(new CloseTicket({ ticketId: key, by: `helper:${text}` }));
      return `Closed ${key}.`;
    }, Effect.orDie);
  }),
);

/** The routes, over whichever platform hosts the desk and the Helper. */
export const app = Effect.gen(function* () {
  const tickets = yield* Ticket;
  const helper = yield* Helper;
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest;
    const url = new URL(request.url, "http://front");
    const [, action, raw] = url.pathname.split("/");
    const id = decodeURIComponent(raw ?? "");
    switch (action) {
      case "ready":
        return yield* HttpServerResponse.json({ ready: true });
      case "open":
        yield* tickets.send(
          new OpenTicket({ ticketId: id, subject: url.searchParams.get("subject") ?? "" }),
        );
        return yield* HttpServerResponse.json({ opened: id });
      case "ticket":
        return yield* HttpServerResponse.json(yield* tickets.get(Ticket.ref(id)));
      case "ask": {
        const reply = yield* helper.get(id).prompt(url.searchParams.get("text") ?? "");
        return yield* HttpServerResponse.json({ answer: reply.text });
      }
      case "session": {
        const session = helper.get(id);
        const { status, queued } = yield* session.status;
        const page = yield* session.history({ take: 100 });
        return yield* HttpServerResponse.json({ status, queued, items: page.items });
      }
      default:
        return HttpServerResponse.text("not found", { status: 404 });
    }
  }).pipe(
    // Answer with the failure, so a case can say what went wrong.
    Effect.catchCause((cause) =>
      Effect.succeed(HttpServerResponse.text(String(cause), { status: 500 })),
    ),
  );
});
