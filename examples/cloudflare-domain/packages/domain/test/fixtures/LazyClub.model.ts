/**
 * `Club.model.ts`, with every aggregate, decision, model and Api given its
 * props as a thunk: the verifier reads a thunk's props as it reads them given directly.
 */
import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

export class Joined extends Domain.Event("Joined", { seat: Schema.String }) {}

export class Left extends Domain.Event("Left", {}) {}

export class SeatTaken extends Domain.Event("SeatTaken", { member: Schema.String }) {}

export class SeatFreed extends Domain.Event("SeatFreed", {}) {}

export class NotFree extends Domain.Rejection("NotFree") {}

export class NotSeated extends Domain.Rejection("NotSeated") {}

/** A member, and the seat they hold. A decision records on it: it decides nothing alone. */
export class Member extends Domain.Aggregate("Member", () => ({
  id: Schema.String,
  state: Schema.Union([
    Schema.TaggedStruct("Out", {}),
    Schema.TaggedStruct("Seated", { seat: Schema.String }),
  ]),
  initial: { _tag: "Out" },
  events: [Joined, Left],
  evolve: {
    Joined: (_, event) => ({ _tag: "Seated" as const, seat: event.seat }),
    Left: () => ({ _tag: "Out" as const }),
  },
})) {}

/** A seat, and the member in it. */
export class Seat extends Domain.Aggregate("Seat", () => ({
  id: Schema.String,
  state: Schema.Union([
    Schema.TaggedStruct("Free", {}),
    Schema.TaggedStruct("Taken", { member: Schema.String }),
  ]),
  initial: { _tag: "Free" },
  events: [SeatTaken, SeatFreed],
  evolve: {
    SeatTaken: (_, event) => ({ _tag: "Taken" as const, member: event.member }),
    SeatFreed: () => ({ _tag: "Free" as const }),
  },
})) {}

export class JoinClub extends Domain.Command("JoinClub", {
  input: { member: Schema.String, seat: Schema.String },
  events: [Joined, SeatTaken],
  rejects: [NotFree],
}) {}

/** A member who is out takes a free seat: both are recorded, or neither. */
export class Join extends Domain.Decision(JoinClub, () => ({
  reads: { member: Member, seat: Seat },
  keyOf: (cmd) => ({ member: cmd.member, seat: cmd.seat }),
  decide: ({ member, seat }) =>
    member.state._tag !== "Out" || seat.state._tag !== "Free"
      ? new NotFree()
      : [
          member.record(new Joined({ seat: seat.id })),
          seat.record(new SeatTaken({ member: member.id })),
        ],
})) {}

export class LeaveClub extends Domain.Command("LeaveClub", {
  input: { member: Schema.String, seat: Schema.String },
  events: [Left, SeatFreed],
  rejects: [NotSeated],
}) {}

/** A member gives up the seat they hold. */
export class Leave extends Domain.Decision(LeaveClub, () => ({
  reads: { member: Member, seat: Seat },
  keyOf: (cmd) => ({ member: cmd.member, seat: cmd.seat }),
  decide: ({ member, seat }) =>
    member.state._tag !== "Seated" || member.state.seat !== seat.id
      ? new NotSeated()
      : [member.record(new Left({})), seat.record(new SeatFreed({}))],
})) {}

/** A member who holds a seat is the one in it. */
const AMemberIsInTheirSeat = Domain.Relation({
  over: { member: Member, seat: Seat },
  holds: ({ member, seat }) =>
    member.state._tag !== "Seated" ||
    member.state.seat !== seat.id ||
    (seat.state._tag === "Taken" && seat.state.member === member.id),
});

/** The members of a club and the seats they hold: each side says the same. */
export class LazyClub extends Domain.Model("LazyClub", () => ({
  aggregates: [Member, Seat],
  decisions: [Join, Leave],
  relations: {
    AMemberIsInTheirSeat: Domain.Relation({
      over: { member: Member, seat: Seat },
      holds: ({ member, seat }) =>
        member.state._tag !== "Seated" ||
        member.state.seat !== seat.id ||
        (seat.state._tag === "Taken" && seat.state.member === member.id),
    }),
    ATakenSeatHasItsMember: Domain.Relation({
      over: { member: Member, seat: Seat },
      holds: ({ member, seat }) =>
        seat.state._tag !== "Taken" ||
        seat.state.member !== member.id ||
        (member.state._tag === "Seated" && member.state.seat === seat.id),
    }),
  },
})) {}

export class LazyClubApi extends Domain.Api("LazyClubApi", () => ({
  model: LazyClub,
  commands: ["JoinClub", "LeaveClub"],
  views: [],
  streams: [],
  queries: [],
})) {}
