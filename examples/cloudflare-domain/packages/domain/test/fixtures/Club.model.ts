import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

export class Joined extends Domain.Event("Joined", { seat: Schema.String }) {}

export class Left extends Domain.Event("Left", {}) {}

export class SeatTaken extends Domain.Event("SeatTaken", { member: Schema.String }) {}

export class SeatFreed extends Domain.Event("SeatFreed", {}) {}

export class NotFree extends Domain.Rejection("NotFree") {}

export class NotSeated extends Domain.Rejection("NotSeated") {}

/** A member, and the seat they hold. A decision records on it: it decides nothing alone. */
export class Member extends Domain.Aggregate("Member", {
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
}) {}

/** A seat, and the member in it. */
export class Seat extends Domain.Aggregate("Seat", {
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
}) {}

export class JoinClub extends Domain.Command("JoinClub", {
  input: { member: Schema.String, seat: Schema.String },
  events: [Joined, SeatTaken],
  rejects: [NotFree],
}) {}

/** A member who is out takes a free seat: both are recorded, or neither. */
export class Join extends Domain.Decision(JoinClub, {
  reads: { member: Member, seat: Seat },
  keyOf: (cmd) => ({ member: cmd.member, seat: cmd.seat }),
  decide: ({ member, seat }) =>
    member.state._tag !== "Out" || seat.state._tag !== "Free"
      ? new NotFree()
      : [
          member.record(new Joined({ seat: seat.id })),
          seat.record(new SeatTaken({ member: member.id })),
        ],
}) {}

export class LeaveClub extends Domain.Command("LeaveClub", {
  input: { member: Schema.String, seat: Schema.String },
  events: [Left, SeatFreed],
  rejects: [NotSeated],
}) {}

/** A member gives up the seat they hold. */
export class Leave extends Domain.Decision(LeaveClub, {
  reads: { member: Member, seat: Seat },
  keyOf: (cmd) => ({ member: cmd.member, seat: cmd.seat }),
  decide: ({ member, seat }) =>
    member.state._tag !== "Seated" || member.state.seat !== seat.id
      ? new NotSeated()
      : [member.record(new Left({})), seat.record(new SeatFreed({}))],
}) {}

/** A member who holds a seat is the one in it. */
const AMemberIsInTheirSeat = Domain.Relation({
  over: { member: Member, seat: Seat },
  holds: ({ member, seat }) =>
    member.state._tag !== "Seated" ||
    member.state.seat !== seat.id ||
    (seat.state._tag === "Taken" && seat.state.member === member.id),
});

/** The members of a club and the seats they hold: each side says the same. */
export class Club extends Domain.Model("Club", {
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
}) {}

export class ClubApi extends Domain.Api("ClubApi", {
  model: Club,
  commands: ["JoinClub", "LeaveClub"],
  views: [],
  streams: [],
  queries: [],
}) {}

/**
 * The same club, with a weaker rule: a seated member's seat is taken, by
 * someone. It is true of every club that can be reached, and it is not
 * enough to prove itself.
 */
export class Vague extends Domain.Model("Vague", {
  aggregates: [Member, Seat],
  decisions: [Join, Leave],
  relations: {
    ASeatedMembersSeatIsTaken: Domain.Relation({
      over: { member: Member, seat: Seat },
      holds: ({ member, seat }) =>
        member.state._tag !== "Seated" ||
        member.state.seat !== seat.id ||
        seat.state._tag === "Taken",
    }),
  },
}) {}

export class VagueApi extends Domain.Api("VagueApi", {
  model: Vague,
  commands: ["JoinClub", "LeaveClub"],
  views: [],
  streams: [],
  queries: [],
}) {}

export class ClearSeat extends Domain.Command("ClearSeat", {
  input: { seat: Schema.String },
  events: [SeatFreed],
  rejects: [NotSeated],
}) {}

/** Frees a seat and tells nobody: the member in it still says they hold it. */
export class Clear extends Domain.Decision(ClearSeat, {
  reads: { seat: Seat },
  keyOf: (cmd) => ({ seat: cmd.seat }),
  decide: ({ seat }) =>
    seat.state._tag !== "Taken" ? new NotSeated() : [seat.record(new SeatFreed({}))],
}) {}

/** A club whose seats can be cleared from under their members. */
export class Careless extends Domain.Model("Careless", {
  aggregates: [Member, Seat],
  decisions: [Join, Clear],
  relations: { AMemberIsInTheirSeat },
}) {}

export class CarelessApi extends Domain.Api("CarelessApi", {
  model: Careless,
  commands: ["JoinClub", "ClearSeat"],
  views: [],
  streams: [],
  queries: [],
}) {}

export class Vacate extends Domain.Command("Vacate", {
  input: { id: Schema.String },
  events: [SeatFreed],
}) {}

/** A seat that frees itself, with a command of its own. */
export class Bench extends Domain.Aggregate("Bench", {
  id: Schema.String,
  state: Schema.Union([
    Schema.TaggedStruct("Free", {}),
    Schema.TaggedStruct("Taken", { member: Schema.String }),
  ]),
  initial: { _tag: "Free" },
  commands: [Vacate],
  keyOf: (cmd) => cmd.id,
  events: [SeatTaken],
  decide: {
    Vacate: (bench) => (bench._tag === "Taken" ? [new SeatFreed({})] : []),
  },
  evolve: {
    SeatTaken: (_, event) => ({ _tag: "Taken" as const, member: event.member }),
    SeatFreed: () => ({ _tag: "Free" as const }),
  },
}) {}

export class SitDown extends Domain.Command("SitDown", {
  input: { member: Schema.String, bench: Schema.String },
  events: [Joined, SeatTaken],
  rejects: [NotFree],
}) {}

export class Sit extends Domain.Decision(SitDown, {
  reads: { member: Member, bench: Bench },
  keyOf: (cmd) => ({ member: cmd.member, bench: cmd.bench }),
  decide: ({ member, bench }) =>
    member.state._tag !== "Out" || bench.state._tag !== "Free"
      ? new NotFree()
      : [
          member.record(new Joined({ seat: bench.id })),
          bench.record(new SeatTaken({ member: member.id })),
        ],
}) {}

/** A park whose benches empty themselves: the member on one still says they sit there. */
export class Park extends Domain.Model("Park", {
  aggregates: [Member, Bench],
  decisions: [Sit],
  relations: {
    AMemberIsOnTheirBench: Domain.Relation({
      over: { member: Member, bench: Bench },
      holds: ({ member, bench }) =>
        member.state._tag !== "Seated" ||
        member.state.seat !== bench.id ||
        (bench.state._tag === "Taken" && bench.state.member === member.id),
    }),
  },
}) {}

export class ParkApi extends Domain.Api("ParkApi", {
  model: Park,
  commands: ["SitDown", "Vacate"],
  views: [],
  streams: [],
  queries: [],
}) {}
