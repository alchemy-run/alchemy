import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { EffectfulContainer } from "./effectful-container.ts";

/**
 * Durable Object backing one effectful container instance. `boot()` measures
 * the time, from inside the DO, until the container is accepting RPC — the
 * `ping()` call blocks through cold start, so the elapsed delta is the time to
 * usable service.
 *
 * Each distinct `getByName(name)` is a distinct DO instance and therefore a
 * distinct container instance, which is how the benchmark spins up N of them.
 */
export class EffectfulObject extends Cloudflare.DurableObject<EffectfulObject>()(
  "BenchEffectfulObject",
  Effect.gen(function* () {
    const container = yield* EffectfulContainer;

    return Effect.gen(function* () {
      return {
        // Time container cold-start → reachable (RPC answers). Leaves the
        // container running so the benchmark can `shutdown()` it separately —
        // the timing must not include teardown. A freshly-built image is still
        // distributing to the edge metal on the first boots, so retry until the
        // RPC port answers.
        boot: () =>
          Effect.gen(function* () {
            const start = yield* Effect.sync(() => Date.now());
            yield* container.ping().pipe(
              Effect.retry({
                schedule: Schedule.exponential("1 second").pipe(
                  Schedule.either(Schedule.spaced("5 seconds")),
                ),
                times: 40,
              }),
            );
            const readyMs = (yield* Effect.sync(() => Date.now())) - start;
            return { readyMs };
          }),
        shutdown: () => container.destroy().pipe(Effect.ignore),
      };
    });
  }).pipe(
    Effect.provide(
      Cloudflare.Containers.layer(EffectfulContainer, {
        enableInternet: true,
      }),
    ),
  ),
) {}
