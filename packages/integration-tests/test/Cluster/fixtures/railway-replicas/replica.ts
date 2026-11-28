/**
 * An entity that says which Railway replica runs it, with a persisted,
 * once-per-`txId` credit whose reply outlives the replica that ran it.
 */
import * as Cluster from "@alchemy.run/effect-cluster";
import { ClusterSchema } from "effect/cluster";
import { Rpc } from "effect/rpc";
import * as Schema from "effect/Schema";

export const Where = Schema.Struct({
  /** `RAILWAY_SERVICE_ID`: the one Service every replica belongs to. */
  service: Schema.String,
  /** `RAILWAY_REPLICA_ID`: this replica. */
  replica: Schema.String,
  /** This replica's own private IPv6 addresses. */
  addresses: Schema.Array(Schema.String),
});

export class Replicas extends Cluster.Entity<Replicas>()("Replica", [
  Rpc.make("Where", { success: Where }),
  Rpc.make("Credit", {
    payload: { txId: Schema.String, amount: Schema.Int },
    primaryKey: ({ txId }) => txId,
    success: Schema.Int,
  }).annotate(ClusterSchema.Persisted, true),
]) {}
