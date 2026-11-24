import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

/** A member's name, sealed under the member's own key. */
export const Name = Domain.Sealed(Schema.String);

export class Joined extends Domain.Event("Joined", { name: Name }) {}

export class Left extends Domain.Event("Left", {}) {}

export class NotYourName extends Domain.Rejection("NotYourName", {}) {}

export class AlreadyJoined extends Domain.Rejection("AlreadyJoined", {}) {}

export class Join extends Domain.Command("Join", {
  input: { id: Schema.String, name: Name },
  events: [Joined],
  rejects: [NotYourName, AlreadyJoined],
}) {}

export class Leave extends Domain.Command("Leave", {
  input: { id: Schema.String },
  events: [Left],
}) {}

/** A member of a club. Its rules read who a sealed name belongs to, never the name. */
export class Member extends Domain.Aggregate("Member", {
  id: Schema.String,
  state: Schema.Struct({ name: Schema.NullOr(Name), joined: Schema.Boolean }),
  initial: { name: null, joined: false },
  commands: [Join, Leave],
  keyOf: (cmd) => cmd.id,
  transitions: {
    /** A member only ever takes a name sealed under their own key. */
    TheNameIsTheirOwn: ({ command, after }) =>
      command._tag !== "Join" || after.name === null || after.name.subject === command.id,
  },
  decide: {
    Join: (member, cmd, { id }) => {
      if (member.joined) return new AlreadyJoined();
      if (cmd.name.subject !== id) return new NotYourName();
      return [new Joined({ name: cmd.name })];
    },
    Leave: (member) => (member.joined ? [new Left({})] : []),
  },
  evolve: {
    Joined: (_, e) => ({ name: e.name, joined: true }),
    Left: (member) => ({ ...member, joined: false }),
  },
}) {}

/** What the club shows of a member: the name, still sealed. */
export class Badge extends Domain.View("Badge", {
  from: [Member],
  key: Member,
  state: Schema.Struct({ name: Schema.NullOr(Name) }),
  initial: { name: null },
  evolve: { Joined: (_, e) => ({ name: e.name }) },
}) {}

/** A club whose members' names are sealed. */
export class Roster extends Domain.Model("Roster", {
  aggregates: [Member],
  views: [Badge],
  sometimes: {
    SomeoneJoins: (roster) => roster.Member.some((member) => member.state.joined),
  },
}) {}

export class RosterApi extends Domain.Api("RosterApi", {
  model: Roster,
  commands: ["Join", "Leave"],
  views: ["Badge"],
  streams: [],
  queries: [],
}) {}

/** The same member, which takes a name sealed under anyone's key. */
export class Lax extends Domain.Aggregate("Lax", {
  id: Schema.String,
  state: Schema.Struct({ name: Schema.NullOr(Name), joined: Schema.Boolean }),
  initial: { name: null, joined: false },
  commands: [Join],
  keyOf: (cmd) => cmd.id,
  transitions: {
    TheNameIsTheirOwn: ({ command, after }) =>
      after.name === null || after.name.subject === command.id,
  },
  decide: {
    Join: (member, cmd) => (member.joined ? new AlreadyJoined() : [new Joined({ name: cmd.name })]),
  },
  evolve: { Joined: (_, e) => ({ name: e.name, joined: true }) },
}) {}
