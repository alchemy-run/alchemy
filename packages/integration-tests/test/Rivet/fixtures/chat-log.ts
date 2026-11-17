/** Durable Streams the conformance suite writes and reads. */
import * as Rivet from "@alchemy.run/rivet";
import * as StreamFormat from "@alchemy.run/rivet/StreamFormat";
import * as Schema from "effect/Schema";

export const Message = Schema.Struct({ user: Schema.String, text: Schema.String });

/** In the format the runtime provides: JSON. */
export class ChatLog extends Rivet.DurableStream<ChatLog>()("ChatLog", {
  schema: Message,
  ttl: "1 day",
}) {}

/** In a format of its own: SchemaBinary frames on a byte stream. */
export class BinaryLog extends Rivet.DurableStream<BinaryLog>()("BinaryLog", {
  schema: Message,
  format: StreamFormat.SchemaBinary(),
}) {}
