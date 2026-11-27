import * as Domain from "@alchemy.run/domain";
import * as Array from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Activity } from "effect/workflow";
import { IssueTicket, Numbers, Seat, SeatBooked, Ticket } from "./Ticket.model.ts";

/**
 * The saga of `Booking`, with its step written the long way round: the same
 * one number and one command, through the library's functions of effects,
 * options, results and streams. It is searched as `Booking` is.
 */
export class Stamping extends Domain.Saga("Stamping", {
  key: Schema.String,
  input: {},
}) {}

export const StampingLive = Stamping.toLayer(
  Effect.gen(function* () {
    const numbers = yield* Numbers;
    const tickets = yield* Ticket;
    return Effect.fn(function* ({ key }) {
      yield* Activity.make({
        name: "issue",
        execute: Effect.gen(function* () {
          const [{ number }] = yield* Effect.all([numbers.next()]);
          const wanted = yield* Stream.make(number).pipe(
            Stream.filter((id) => id === number),
            Stream.runHead,
          );
          const ids = Array.fromOption(wanted);
          const sent = yield* Effect.forEach(ids, (id) =>
            tickets.send(new IssueTicket({ id, seat: key })).pipe(Effect.result),
          );
          return yield* Effect.succeed(Array.every(sent, Result.isSuccess)).pipe(
            Effect.filterOrFail(
              (all) => all || Option.isNone(wanted),
              () => "refused" as const,
            ),
            Effect.catch(() => Effect.succeed(false)),
            Effect.asVoid,
          );
        }),
      });
    });
  }),
);

export class StartStamping extends Domain.Policy("StartStamping", {
  from: Seat,
  on: [SeatBooked],
}) {}

export const StartStampingLive = StartStamping.toLayer(
  Effect.gen(function* () {
    const stamping = yield* Stamping;
    return Effect.fn(function* ({ source }) {
      yield* stamping.start(source, {});
    });
  }),
);

export class Booth extends Domain.Model("Booth", {
  aggregates: [Seat, Ticket],
  policies: [StartStamping],
  sagas: [Stamping],
  invariants: {
    OneTicketPerSeat: (booth) =>
      booth.Seat.every(
        (seat) => booth.Ticket.filter((ticket) => ticket.state.seat === seat.id).length <= 1,
      ),
  },
}) {}

export class BoothApi extends Domain.Api("BoothApi", {
  model: Booth,
  commands: ["BookSeat"],
  views: [],
  streams: [],
  queries: [],
}) {}
