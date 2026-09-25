// Relative import (not `@/` alias) so this file runs under both Bun and Node
// without a paths-aware loader.
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { launch } from "../../../src/Local/RpcServer.ts";

/**
 * Two provider groups with different shutdown times: a group whose URL ends
 * in `#slow` takes 30 seconds to close, any other group prints `FAST_CLOSED`
 * when it closes.
 */
class Fast extends Context.Service<
  Fast,
  { ping: () => Effect.Effect<string> }
>()("Test.Fast") {}

class Slow extends Context.Service<
  Slow,
  { ping: () => Effect.Effect<string> }
>()("Test.Slow") {}

const FastLive = Layer.effect(
  Fast,
  Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Console.log("FAST_CLOSED"));
    return { ping: () => Effect.succeed("fast") };
  }),
);

const SlowLive = Layer.effect(
  Slow,
  Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Effect.sleep("30 seconds"));
    return { ping: () => Effect.succeed("slow") };
  }),
);

launch((group) =>
  Effect.succeed(group.endsWith("#slow") ? SlowLive : FastLive),
);
