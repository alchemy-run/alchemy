import * as Convex from "@alchemy.run/convex/Server";
import * as Schema from "effect/Schema";

export const Messages = Convex.Table(
  "messages",
  Schema.Struct({
    channel: Schema.String.check(Schema.isMaxLength(20)),
    body: Schema.NonEmptyString,
    sentAt: Schema.DateFromMillis,
    delivered: Schema.optionalKey(Schema.Boolean),
  }),
  (table) => table.index("by_channel", ["channel"]),
);

export class EmptyChannel extends Schema.TaggedError<EmptyChannel>()("EmptyChannel", {
  body: Schema.String,
}) {}

export class ListMessages extends Convex.Query<ListMessages>()("messages:list", {
  args: Schema.Struct({ channel: Schema.String }),
  returns: Schema.Array(Messages.Document),
}) {}

export class GetMessage extends Convex.Query<GetMessage>()("messages:get", {
  args: Schema.Struct({ id: Messages.Id }),
  returns: Schema.OptionFromNullOr(Messages.Document),
}) {}

export class AddMessage extends Convex.Mutation<AddMessage>()("messages:add", {
  args: Schema.Struct({ channel: Schema.String, body: Schema.String }),
  returns: Messages.Id,
  error: EmptyChannel,
}) {}

export class AddThenFail extends Convex.Mutation<AddThenFail>()("messages:addThenFail", {
  args: Schema.Struct({ channel: Schema.String }),
  error: EmptyChannel,
}) {}

export class MarkDelivered extends Convex.Mutation<MarkDelivered>()("messages:markDelivered", {
  args: Schema.Struct({ id: Messages.Id }),
  internal: true,
}) {}

export class Summarize extends Convex.Action<Summarize>()("messages:summarize", {
  args: Schema.Struct({ channel: Schema.String }),
  returns: Schema.Number,
}) {}

export class WhoAmI extends Convex.Query<WhoAmI>()("messages:whoami", {
  args: Schema.Struct({}),
  returns: Schema.NullOr(Schema.String),
}) {}
