/**
 * A counter entity: volatile and persisted messages, a typed failure, a
 * stream and middleware, plus the RPCs the conformance cases use to see how
 * a host runs handlers (forks, defects, interrupts, scheduled delivery).
 */
import * as Cluster from "@alchemy.run/effect-cluster";
import { ClusterSchema, DeliverAt } from "effect/cluster";
import * as DateTime from "effect/DateTime";
import * as PrimaryKey from "effect/PrimaryKey";
import { Rpc } from "effect/rpc";
import * as Schema from "effect/Schema";
import { Auth } from "./auth.ts";

export class CounterBoom extends Schema.TaggedError<CounterBoom>()("CounterBoom", {
  reason: Schema.String,
}) {}

/** An amount to add at `at` (epoch milliseconds), once per `operationId`. */
export class LaterAdd extends Schema.Class<LaterAdd>("LaterAdd")({
  operationId: Schema.String,
  amount: Schema.Int,
  at: Schema.Number,
}) {
  [PrimaryKey.symbol]() {
    return this.operationId;
  }
  [DeliverAt.symbol]() {
    return DateTime.makeUnsafe(this.at);
  }
}

export class Counters extends Cluster.Entity<Counters>()("Counter", [
  Rpc.make("Increment", { payload: { amount: Schema.Int }, success: Schema.Int }),
  Rpc.make("Get", { success: Schema.Int }),
  Rpc.make("Add", {
    payload: { operationId: Schema.String, amount: Schema.Int },
    primaryKey: ({ operationId }) => operationId,
    success: Schema.Int,
  }).annotate(ClusterSchema.Persisted, true),
  Rpc.make("AddLater", { payload: LaterAdd, success: Schema.Int }).annotate(
    ClusterSchema.Persisted,
    true,
  ),
  Rpc.make("Boom", { error: CounterBoom }),
  Rpc.make("Tick", { payload: { n: Schema.Int }, success: Schema.Int, stream: true }),
  Rpc.make("Whoami", { success: Schema.String }),
  Rpc.make("Secret", { success: Schema.String }).middleware(Auth),
  /** Dies on its first run for an id, then answers with the count. */
  Rpc.make("Flaky", { success: Schema.Int }),
  /** Waits for `Release`, holding the instance's only permit. */
  Rpc.make("Wait", { success: Schema.String }),
  /** Releases `Wait`; forked, so it runs while `Wait` holds the permit. */
  Rpc.make("Release"),
  /** Never answers; records that it was interrupted. */
  Rpc.make("Hang", { success: Schema.String }),
  Rpc.make("WasInterrupted", { success: Schema.Boolean }),
  /** Takes two seconds, and finishes even if its caller stops waiting. */
  Rpc.make("Settle", { success: Schema.String }),
  Rpc.make("Settled", { success: Schema.Boolean }),
  /** Records that it ran. */
  Rpc.make("Mark"),
  Rpc.make("Marked", { success: Schema.Boolean }),
  /** Counts to `n`, one value every `everyMillis`, once per `operationId`. */
  Rpc.make("Countdown", {
    payload: { operationId: Schema.String, n: Schema.Int, everyMillis: Schema.Int },
    primaryKey: ({ operationId }) => operationId,
    success: Schema.Int,
    stream: true,
  }).annotate(ClusterSchema.Persisted, true),
  /** How many times `Countdown`'s handler has run. */
  Rpc.make("CountdownRuns", { success: Schema.Int }),
  /** When `AddLater` last ran (epoch milliseconds), or 0. */
  Rpc.make("RanAt", { success: Schema.Number }),
]) {}
