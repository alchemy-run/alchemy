import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
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
        boot: () =>
          Effect.gen(function* () {
            const start = yield* Effect.sync(() => Date.now());
            yield* container.ping();
            const end = yield* Effect.sync(() => Date.now());
            return { ms: end - start };
          }),
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
