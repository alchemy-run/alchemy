/** A counter entity: volatile and persisted messages, a typed failure, and a stream. */
import * as EffectCluster from "@alchemy.run/effect-cluster";
import { ClusterSchema, Entity } from "effect/cluster";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { Rpc } from "effect/rpc";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Default } from "./cluster.ts";

export class CounterBoom extends Schema.TaggedError<CounterBoom>()("CounterBoom", {
  reason: Schema.String,
}) {}

export const Counter = Entity.make("Counter", [
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
]);

export default class Counters extends EffectCluster.Entity<Counters>()(
  Counter,
  { main: import.meta.url },
  Effect.gen(function* () {
    return Effect.gen(function* () {
      const { entityId } = yield* Entity.CurrentAddress;
      const count = yield* Ref.make(0);
      return Counter.of({
        Increment: ({ payload }) => Ref.updateAndGet(count, (n) => n + payload.amount),
        Get: () => Ref.get(count),
        Add: ({ payload }) => Ref.updateAndGet(count, (n) => n + payload.amount),
        Boom: () => Effect.fail(new CounterBoom({ reason: "expected" })),
        Tick: ({ payload }) => Stream.range(1, payload.n),
        Whoami: () => Effect.succeed(entityId),
      });
    });
  }).pipe(Effect.provide(Default)),
) {}
