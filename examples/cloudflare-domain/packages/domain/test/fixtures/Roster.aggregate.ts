import * as Domain from "@alchemy.run/domain";
import * as Array from "effect/Array";
import * as HashMap from "effect/HashMap";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** The most people a roster takes. */
const SEATS = 3;

export class Joined extends Domain.Event("Joined", { person: Schema.String }) {}

export class Left extends Domain.Event("Left", { person: Schema.String }) {}

export class Scored extends Domain.Event("Scored", {
  person: Schema.String,
  points: Schema.Int,
}) {}

export class Dropped extends Domain.Event("Dropped", { person: Schema.String }) {}

export class Led extends Domain.Event("Led", { person: Schema.String }) {}

export class Full extends Domain.Rejection("Full", {}) {}

export class NotAMember extends Domain.Rejection("NotAMember", {}) {}

export class Join extends Domain.Command("Join", {
  input: { id: Schema.String, person: Schema.String },
  events: [Joined],
  rejects: [Full],
}) {}

export class Leave extends Domain.Command("Leave", {
  input: { id: Schema.String, person: Schema.String },
  events: [Left],
}) {}

export class Score extends Domain.Command("Score", {
  input: {
    id: Schema.String,
    person: Schema.String,
    points: Schema.Int.check(Schema.isGreaterThan(0)),
  },
  events: [Scored],
  rejects: [NotAMember],
}) {}

export class Lead extends Domain.Command("Lead", {
  input: { id: Schema.String },
  events: [Led],
}) {}

export class Drop extends Domain.Command("Drop", {
  input: { id: Schema.String, person: Schema.String },
  events: [Dropped],
}) {}

/**
 * The members of a team, and the points each has. The members are a hash
 * set and the points a hash map: only a member has points, and the total is
 * the sum of them. Dropping a member forgets to take their points.
 */
export class Roster extends Domain.Aggregate("Roster", {
  id: Schema.String,
  state: Schema.Struct({
    members: Schema.HashSet(Schema.String),
    points: Schema.HashMap(Schema.String, Schema.Int.check(Schema.isGreaterThan(0))),
    total: Schema.Int,
    lead: Schema.Option(Schema.String),
  }),
  initial: {
    members: HashSet.empty<string>(),
    points: HashMap.empty<string, number>(),
    total: 0,
    lead: Option.none(),
  },
  invariants: {
    NeverMoreThanTheSeats: (roster) => HashSet.size(roster.members) <= SEATS,
    OnlyAMemberHasPoints: (roster) =>
      HashMap.every(roster.points, (_points, person) => HashSet.has(roster.members, person)),
    TheTotalIsTheSumOfThePoints: (roster) =>
      roster.total === HashMap.reduce(roster.points, 0, (sum, points) => sum + points),
  },
  transitions: {
    ALeadIsAMember: ({ before, after, command }) =>
      command._tag !== "Lead" ||
      Option.match(after.lead, {
        onNone: () => true,
        onSome: (person) => HashSet.has(before.members, person),
      }),
  },
  commands: [Join, Leave, Score, Lead, Drop],
  keyOf: (command) => command.id,
  decide: {
    Join: (roster, command) =>
      HashSet.has(roster.members, command.person)
        ? []
        : HashSet.size(roster.members) >= SEATS
          ? new Full()
          : [new Joined({ person: command.person })],
    Leave: (roster, command) =>
      HashSet.has(roster.members, command.person) ? [new Left({ person: command.person })] : [],
    Score: (roster, command) =>
      roster.members.pipe(HashSet.has(command.person))
        ? [new Scored({ person: command.person, points: command.points })]
        : new NotAMember(),
    // The first member the set gives: which one that is, is the order of their hashes.
    Lead: (roster) =>
      Option.match(Array.head(Array.fromIterable(roster.members)), {
        onNone: () => [],
        onSome: (person) => [new Led({ person })],
      }),
    Drop: (roster, command) =>
      HashSet.has(roster.members, command.person) ? [new Dropped({ person: command.person })] : [],
  },
  evolve: {
    Joined: (roster, event) => ({ ...roster, members: HashSet.add(roster.members, event.person) }),
    // The points go with the member, and come off the total.
    Left: (roster, event) => ({
      ...roster,
      members: HashSet.remove(roster.members, event.person),
      points: HashMap.remove(roster.points, event.person),
      total: roster.total - Option.getOrElse(HashMap.get(roster.points, event.person), () => 0),
    }),
    Scored: (roster, event) => ({
      ...roster,
      points: HashMap.modifyAt(roster.points, event.person, (held) =>
        Option.some(Option.getOrElse(held, () => 0) + event.points),
      ),
      total: roster.total + event.points,
    }),
    Led: (roster, event) => ({ ...roster, lead: Option.some(event.person) }),
    // The member goes, and their points stay.
    Dropped: (roster, event) => ({
      ...roster,
      members: HashSet.remove(roster.members, event.person),
    }),
  },
}) {}
