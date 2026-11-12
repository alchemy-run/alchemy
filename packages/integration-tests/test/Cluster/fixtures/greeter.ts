/** A second entity in the same pool, which calls the counter. */
import * as Cluster from "@alchemy.run/effect-cluster";
import { Rpc } from "effect/rpc";
import * as Schema from "effect/Schema";

export class Greeters extends Cluster.Entity<Greeters>()("Greeter", [
  Rpc.make("Greet", { payload: { name: Schema.String }, success: Schema.String }),
  /** Calls the counter's `Hang` and gives up after a second. */
  Rpc.make("HangCounter", { payload: { id: Schema.String }, success: Schema.String }),
  /** Calls the counter's `Settle` or `Mark` and gives up after half a second. */
  Rpc.make("AbandonCounter", {
    payload: { id: Schema.String, call: Schema.Literals(["Settle", "Mark"]) },
    success: Schema.String,
  }),
]) {}
