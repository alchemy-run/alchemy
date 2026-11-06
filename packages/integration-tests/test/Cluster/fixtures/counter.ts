/** A counter entity: volatile and persisted messages, a typed failure, a stream and middleware. */
import * as Cluster from "@alchemy.run/effect-cluster";
import { ClusterSchema } from "effect/cluster";
import { Rpc } from "effect/rpc";
import * as Schema from "effect/Schema";
import { Auth } from "./auth.ts";

export class CounterBoom extends Schema.TaggedError<CounterBoom>()("CounterBoom", {
  reason: Schema.String,
}) {}

export class Counters extends Cluster.Entity<Counters>()("Counter", [
  Rpc.make("Increment", { payload: { amount: Schema.Int }, success: Schema.Int }),
  Rpc.make("Get", { success: Schema.Int }),
  Rpc.make("Add", {
    payload: { operationId: Schema.String, amount: Schema.Int },
    primaryKey: ({ operationId }) => operationId,
    success: Schema.Int,
  }).annotate(ClusterSchema.Persisted, true),
  Rpc.make("Boom", { error: CounterBoom }),
  Rpc.make("Tick", { payload: { n: Schema.Int }, success: Schema.Int, stream: true }),
  Rpc.make("Whoami", { success: Schema.String }),
  Rpc.make("Secret", { success: Schema.String }).middleware(Auth),
]) {}
