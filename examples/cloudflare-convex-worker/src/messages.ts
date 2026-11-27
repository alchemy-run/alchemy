// src/messages.ts
import * as Convex from "@alchemy.run/convex/Server";
import * as Schema from "effect/Schema";

export const Messages = Convex.Table("messages", Schema.Struct({ body: Schema.String }));

export class ListMessages extends Convex.Query<ListMessages>()("messages:list", {
  args: Schema.Struct({}),
  returns: Schema.Array(Messages.Document),
}) {}

export class AddMessage extends Convex.Mutation<AddMessage>()("messages:add", {
  args: Schema.Struct({ body: Schema.String }),
  returns: Messages.Id,
}) {}
