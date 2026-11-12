/**
 * An entity whose mailbox holds two messages: a third volatile message is
 * turned away, and a third persisted one waits in storage for its turn.
 */
import * as Cluster from "@alchemy.run/effect-cluster";
import { ClusterSchema } from "effect/cluster";
import { Rpc } from "effect/rpc";
import * as Schema from "effect/Schema";

export class Turnstiles extends Cluster.Entity<Turnstiles>()("Turnstile", [
  /** Takes a second and a half; answers with how many have passed. */
  Rpc.make("Pass", { success: Schema.Int }),
  /** The same, persisted: once per `ticket`. */
  Rpc.make("PassOnce", {
    payload: { ticket: Schema.String },
    primaryKey: ({ ticket }) => ticket,
    success: Schema.Int,
  }).annotate(ClusterSchema.Persisted, true),
  Rpc.make("Passed", { success: Schema.Int }),
]) {}
