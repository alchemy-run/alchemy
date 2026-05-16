import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

export const PingRpcs = RpcGroup.make(
  Rpc.make("Ping", {
    payload: { message: Schema.String },
    success: Schema.Struct({ echo: Schema.String, n: Schema.Number }),
  }),
  Rpc.make("Slow", {
    payload: { ms: Schema.Number },
    success: Schema.Struct({ slept: Schema.Number }),
  }),
);
