import { Rpc, RpcGroup } from "effect/rpc";
import * as Schema from "effect/Schema";

export const Session = Schema.Struct({
  runToken: Schema.String,
  actorId: Schema.String,
  versionId: Schema.String,
  connectionId: Schema.Number,
  count: Schema.Number,
  metadataBytes: Schema.Number,
});

export class WebSocketRpcs extends RpcGroup.make(
  Rpc.make("begin", {
    payload: { runToken: Schema.String, count: Schema.Number, metadataBytes: Schema.Number },
    success: Session,
  }),
  Rpc.make("hold", { payload: {}, success: Session, stream: true }),
  Rpc.make("short", { payload: { index: Schema.Number }, success: Schema.Number }),
  Rpc.make("release", { payload: {}, success: Schema.Boolean }),
  Rpc.make("finish", {
    payload: {},
    success: Schema.Struct({
      ...Session.fields,
      calls: Schema.Number,
      checksum: Schema.Number,
      held: Schema.Boolean,
      metadataPreserved: Schema.Boolean,
    }),
  }),
) {}
