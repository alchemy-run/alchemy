import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";

type Assert<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type LayerRequirements<T> = T extends Layer.Layer<infer _A, infer _E, infer R> ? R : never;

interface CounterShape {
  readonly get: () => Effect.Effect<number>;
}

class Counter extends Cloudflare.DurableObject<Counter, CounterShape>()("Counter") {}

const CounterLive = Counter.make(Effect.succeed(Effect.succeed({ get: () => Effect.succeed(0) })));

// #2848: the class-form `make` Layer requires exactly the host Worker, not `any`.
export type _CounterLiveRequiresWorker = Assert<
  Equal<LayerRequirements<typeof CounterLive>, Cloudflare.Worker>
>;
