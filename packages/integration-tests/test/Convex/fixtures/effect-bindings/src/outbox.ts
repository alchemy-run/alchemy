import * as AWS from "@alchemy.run/aws";
import * as Convex from "@alchemy.run/convex/Server";
import * as Schema from "effect/Schema";

export const Outbox = AWS.SQS.Queue("Outbox");

export class Publish extends Convex.Action<Publish>()("outbox:publish", {
  args: Schema.Struct({ body: Schema.String }),
  returns: Schema.String,
}) {}
