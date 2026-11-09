import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";

// A helper written against the ambient global `DurableObjectState`.
const describe = (ctx: DurableObjectState): string => ctx.id.toString();

export class Counter extends Cloudflare.DurableObject<
  Counter,
  {
    readonly id: () => Effect.Effect<string>;
    readonly copy: () => Effect.Effect<unknown>;
  }
>()("Counter") {}

export default Counter.make(
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.sync(() => ({
      id: () => Effect.succeed(describe(state.raw)),
      // `raw` round-trips through alchemy's converter.
      copy: () => Effect.succeed(Cloudflare.fromDurableObjectState(state.raw)),
    }));
  }),
);
