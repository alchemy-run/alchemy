import * as Schema from "effect/Schema";
import { Rpc, RpcGroup } from "effect/unstable/rpc";

export const Session = Schema.Struct({
  version: Schema.Literal(1),
  userId: Schema.String,
  connectedAt: Schema.DateFromString,
});

export class RoomRpcs extends RpcGroup.make(
  Rpc.make("greet", {
    payload: { name: Schema.String },
    success: Schema.String,
  }),
  Rpc.make("session", {
    payload: { userId: Schema.String },
    success: Schema.Void,
  }),
  Rpc.make("watch", { success: Schema.Number, stream: true }),
  Rpc.make("release", { success: Schema.Void }),
  Rpc.make("stats", {
    success: Schema.Struct({
      boots: Schema.Number,
      active: Schema.Number,
      finalized: Schema.Number,
      userId: Schema.NullOr(Schema.String),
      dateDecoded: Schema.Boolean,
    }),
  }),
) {}
