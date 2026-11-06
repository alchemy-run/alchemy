/** A second entity in the same pool, which calls the counter. */
import * as Cluster from "@alchemy.run/effect-cluster";
import { Rpc } from "effect/rpc";
import * as Schema from "effect/Schema";

export class Greeters extends Cluster.Entity<Greeters>()("Greeter", [
  Rpc.make("Greet", { payload: { name: Schema.String }, success: Schema.String }),
]) {}
