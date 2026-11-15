/**
 * An entity that runs its messages concurrently and stops after five idle
 * seconds: duplicates of a persisted message must still run once, and an
 * instance kept alive must keep its state.
 */
import * as Cluster from "@alchemy.run/effect-cluster";
import { ClusterSchema } from "effect/cluster";
import { Rpc } from "effect/rpc";
import * as Schema from "effect/Schema";

export class Ledgers extends Cluster.Entity<Ledgers>()("Ledger", [
  Rpc.make("Credit", {
    payload: { txId: Schema.String, amount: Schema.Int },
    primaryKey: ({ txId }) => txId,
    success: Schema.Int,
  }).annotate(ClusterSchema.Persisted, true),
  Rpc.make("Balance", { success: Schema.Int }),
  Rpc.make("Remember", { payload: { value: Schema.Int } }),
  Rpc.make("Recall", { success: Schema.Int }),
  /** Keeps the instance running past its idle time. */
  Rpc.make("Pin"),
  /** How many times this id's instance has been built by the process answering. */
  Rpc.make("Builds", { success: Schema.Int }),
  /** When the instance answering was built (epoch milliseconds). */
  Rpc.make("BuiltAt", { success: Schema.Number }),
  /** A persisted message as large as its `text`; answers with its length. */
  Rpc.make("Note", {
    payload: { txId: Schema.String, text: Schema.String },
    primaryKey: ({ txId }) => txId,
    success: Schema.Int,
  }).annotate(ClusterSchema.Persisted, true),
]) {}
