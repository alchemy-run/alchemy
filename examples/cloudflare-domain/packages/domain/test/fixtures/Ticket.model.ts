import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class SeatBooked extends Domain.Event("SeatBooked", {}) {}

export class AlreadyBooked extends Domain.Rejection("AlreadyBooked", {}) {}

export class BookSeat extends Domain.Command("BookSeat", {
  target: Schema.String,
  input: {},
  events: [SeatBooked],
  rejects: [AlreadyBooked],
}) {}

export class Seat extends Domain.Aggregate("Seat", {
  id: Schema.String,
  state: Schema.Struct({ booked: Schema.Boolean }),
  initial: { booked: false },
  commands: [BookSeat],
  decide: {
    BookSeat: (seat) => (seat.booked ? new AlreadyBooked() : [new SeatBooked({})]),
  },
  evolve: { SeatBooked: () => ({ booked: true }) },
}) {}

export class TicketIssued extends Domain.Event("TicketIssued", { seat: Schema.String }) {}

export class IssueTicket extends Domain.Command("IssueTicket", {
  target: Schema.String,
  input: { seat: Schema.String },
  events: [TicketIssued],
}) {}

export class Ticket extends Domain.Aggregate("Ticket", {
  id: Schema.String,
  state: Schema.Struct({ seat: Schema.NullOr(Schema.String) }),
  initial: { seat: null },
  commands: [IssueTicket],
  decide: {
    IssueTicket: (ticket, command) =>
      ticket.seat === null ? [new TicketIssued({ seat: command.seat })] : [],
  },
  evolve: { TicketIssued: (_, event) => ({ seat: event.seat }) },
}) {}

/** Hands out ticket numbers. It never gives the same one twice. */
export class Numbers extends Domain.ExternalSystem("Numbers", {
  next: { success: { number: Schema.String } },
}) {}

/** Whenever a seat is booked, issue a ticket under the next number. */
export class Issue extends Domain.Policy("Issue", { from: Seat, on: [SeatBooked] }) {}

export const IssueLive = Issue.toLayer(
  Effect.gen(function* () {
    const numbers = yield* Numbers;
    const tickets = yield* Ticket;
    return Effect.fn(function* ({ source }) {
      const { number } = yield* numbers.next();
      yield* tickets.send(number, new IssueTicket({ seat: source.id }));
    });
  }),
);

/**
 * A seat gets one ticket, as long as its event is handled once. The ticket's
 * id comes from outside, so handling the event again asks for another number
 * and issues a second ticket: the kernel's command ids do not help, because
 * the second command goes to another instance.
 */
export class Tickets extends Domain.Model("Tickets", {
  aggregates: [Seat, Ticket],
  policies: [Issue],
  invariants: {
    OneTicketPerSeat: (tickets) =>
      tickets.Seat.every(
        (seat) => tickets.Ticket.filter((ticket) => ticket.state.seat === seat.id).length <= 1,
      ),
  },
}) {}

export class TicketsApi extends Domain.Api("TicketsApi", {
  model: Tickets,
  commands: ["BookSeat"],
  views: [],
  streams: [],
  queries: [],
}) {}
