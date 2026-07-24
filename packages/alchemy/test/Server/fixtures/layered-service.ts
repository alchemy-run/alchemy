/**
 * Fixture for the constructor-LAYERS lifetime contract: `Ticker` OWNS
 * machinery (a fiber forked into its build scope). Declared as the
 * class's `layers` argument, that fiber must live for the process —
 * NOT die when init returns — and an inline `Effect.provide` of the
 * same layer reference inside init must dedupe into the same build
 * (one instance, one background fiber).
 */
import * as Server from "@/Server/index.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

let builds = 0;

class Ticker extends Context.Service<
  Ticker,
  { readonly count: Effect.Effect<number> }
>()("test/Ticker") {}

const TickerLive = Layer.effect(
  Ticker,
  Effect.gen(function* () {
    builds++;
    const scope = yield* Effect.scope;
    let ticks = 0;
    yield* Effect.forkIn(
      Effect.repeat(
        Effect.sync(() => ticks++),
        Schedule.spaced("50 millis"),
      ),
      scope,
    );
    return { count: Effect.sync(() => ticks) };
  }),
);

export default class LayeredApi extends Server.Service<LayeredApi>()(
  "LayeredApi",
  { main: import.meta.url, memo: false },
  Effect.gen(function* () {
    const ticker = yield* Ticker;
    // inline provide of the SAME layer reference: must be a memo hit
    // on the class-level build, not a second (doomed) instance
    const viaProvide = yield* Effect.provide(
      Effect.andThen(Effect.void, Ticker),
      TickerLive,
    );
    const sameInstance = viaProvide === ticker;

    return {
      fetch: Effect.gen(function* () {
        const before = yield* ticker.count;
        yield* Effect.sleep("300 millis");
        const after = yield* ticker.count;
        return yield* HttpServerResponse.json({
          builds,
          sameInstance,
          before,
          after,
          // the fiber is alive iff it ticked while we slept — long
          // after init returned its handlers
          alive: after > before,
        }).pipe(Effect.orDie);
      }),
    };
  }),
  TickerLive,
) {}
