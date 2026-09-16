/**
 * Fixture for the Host.run lifetime contract: `Ticker` registers its
 * background fiber via {@link Local.runOnHost} and the constructor
 * provides it with plain `Effect.provide` (NOT the layers slot). The
 * fiber must still be running when requests arrive — long after init
 * returned its handlers.
 */
import * as Local from "@/Local/index.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

class Ticker extends Context.Service<
  Ticker,
  { readonly count: Effect.Effect<number> }
>()("test/HostedTicker") {}

const TickerLive = Layer.effect(
  Ticker,
  Effect.gen(function* () {
    let ticks = 0;
    yield* Local.runOnHost(
      Effect.repeat(
        Effect.sync(() => ticks++),
        Schedule.spaced("50 millis"),
      ).pipe(Effect.asVoid),
    );
    return { count: Effect.sync(() => ticks) };
  }),
);

export default class HostedApi extends Local.Service<HostedApi>()(
  "HostedApi",
  { main: import.meta.url, memo: false },
  Effect.gen(function* () {
    const ticker = yield* Ticker;
    return {
      fetch: Effect.gen(function* () {
        const before = yield* ticker.count;
        yield* Effect.sleep("300 millis");
        const after = yield* ticker.count;
        return yield* HttpServerResponse.json({
          before,
          after,
          alive: after > before,
        }).pipe(Effect.orDie);
      }),
    };
  }).pipe(Effect.provide(TickerLive)),
) {}
