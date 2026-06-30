import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

/**
 * A container whose process exits immediately on every start (see
 * `crashloop-context/Dockerfile`). Reaching it always fails; the benchmark
 * measures HOW LONG until that failure surfaces, to prove Alchemy fails fast on
 * a fatal crash (like native wrangler) rather than burning the full readiness
 * budget.
 */
export class BenchCrashContainer extends Cloudflare.Container<BenchCrashContainer>()(
  "BenchCrashContainer",
  {
    context: `${import.meta.dirname}/crashloop-context`,
    maxInstances: 100,
    instanceType: "lite",
    instances: 0,
  },
) {}

export class BenchCrashObject extends Cloudflare.DurableObject<BenchCrashObject>()(
  "BenchCrashObject",
  Effect.gen(function* () {
    const container = yield* BenchCrashContainer;

    return Effect.gen(function* () {
      const { fetch } = yield* container.getTcpPort(8080);

      return {
        // Attempt to reach the crash-looping container, returning how long until
        // the attempt resolves (it always fails) and whether it succeeded. The
        // elapsed time is the fail-fast metric.
        boot: () =>
          Effect.gen(function* () {
            const start = yield* Effect.sync(() => Date.now());
            const ok = yield* fetch(
              HttpClientRequest.get("http://container/"),
            ).pipe(
              Effect.as(true),
              Effect.catchCause(() => Effect.succeed(false)),
            );
            const ms = (yield* Effect.sync(() => Date.now())) - start;
            return { ms, ok };
          }),
      };
    });
  }).pipe(
    Effect.provide(
      Cloudflare.Containers.layer(BenchCrashContainer, {
        enableInternet: true,
      }),
    ),
  ),
) {}
