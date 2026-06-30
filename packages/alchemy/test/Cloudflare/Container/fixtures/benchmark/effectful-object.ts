import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { BenchEffectfulContainer } from "./effectful-container.ts";

/**
 * Durable Object backing one effectful container instance. `boot()` measures
 * the time, from inside the DO, until the container is accepting RPC — the
 * `ping()` call blocks through the container's cold start (the start layer
 * polls the container until its port answers), so the elapsed delta is the
 * "started and reachable" latency.
 *
 * Each distinct `getByName(name)` is a distinct DO instance and therefore a
 * distinct container instance, which is how the benchmark spins up N of them.
 */
export class BenchEffectfulObject extends Cloudflare.DurableObject<BenchEffectfulObject>()(
  "BenchEffectfulObject",
  Effect.gen(function* () {
    const container = yield* BenchEffectfulContainer;

    return Effect.gen(function* () {
      return {
        // Time container cold-start → reachable (RPC answers). Leaves the
        // container running so the benchmark can `shutdown()` it separately —
        // the boot timing must not include teardown.
        boot: () =>
          Effect.gen(function* () {
            const start = yield* Effect.sync(() => Date.now());
            // A freshly-built image is still distributing to the edge metal on
            // the first boots after a deploy, so the container start errors
            // until it lands. Retry so the FIRST boot records the true
            // post-deploy cold start (distribution + start → reachable) instead
            // of failing — that wait IS the cold start we want to measure.
            yield* container.ping().pipe(
              Effect.retry({
                schedule: Schedule.exponential("1 second").pipe(
                  Schedule.either(Schedule.spaced("5 seconds")),
                ),
                times: 40,
              }),
            );
            const end = yield* Effect.sync(() => Date.now());
            return { bootMs: end - start, readyMs: end - start };
          }),
        // Tear the container down so each boot is an independent cold start and
        // repeated boots don't accumulate against the account's
        // concurrent-container cap.
        shutdown: () => container.destroy().pipe(Effect.ignore),
      };
    });
  }).pipe(
    Effect.provide(
      Cloudflare.Containers.layer(BenchEffectfulContainer, {
        enableInternet: true,
      }),
    ),
  ),
) {}
