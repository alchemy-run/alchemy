import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Activity } from "effect/workflow";
import { IssueTicket, Numbers, Seat, SeatBooked, Ticket } from "./Ticket.model.ts";

/** Issues the ticket for a booked seat, in one step. */
export class Ticketing extends Domain.Saga("Ticketing", {
  key: Schema.String,
  input: {},
}) {}

export const TicketingLive = Ticketing.toLayer(
  Effect.gen(function* () {
    const numbers = yield* Numbers;
    const tickets = yield* Ticket;
    return Effect.fn(function* ({ key }) {
      yield* Activity.make({
        name: "issue",
        execute: Effect.gen(function* () {
          const { number } = yield* numbers.next();
          yield* tickets.send(new IssueTicket({ id: number, seat: key }));
        }),
      });
    });
  }),
);

/** Whenever a seat is booked, start issuing its ticket. */
export class StartTicketing extends Domain.Policy("StartTicketing", {
  from: Seat,
  on: [SeatBooked],
}) {}

export const StartTicketingLive = StartTicketing.toLayer(
  Effect.gen(function* () {
    const ticketing = yield* Ticketing;
    return Effect.fn(function* ({ source }) {
      yield* ticketing.start(source, {});
    });
  }),
);

/**
 * A seat gets one ticket, as long as the saga's step runs once. A saga that
 * stops after the step and before its result is kept runs the step again:
 * it asks for another number, and the ticket goes to another instance.
 */
export class Booking extends Domain.Model("Booking", {
  aggregates: [Seat, Ticket],
  policies: [StartTicketing],
  sagas: [Ticketing],
  invariants: {
    OneTicketPerSeat: (booking) =>
      booking.Seat.every(
        (seat) => booking.Ticket.filter((ticket) => ticket.state.seat === seat.id).length <= 1,
      ),
  },
}) {}

export class BookingApi extends Domain.Api("BookingApi", {
  model: Booking,
  commands: ["BookSeat"],
  views: [],
  streams: [],
  queries: [],
}) {}
