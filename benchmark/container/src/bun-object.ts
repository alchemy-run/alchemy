import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { BunContainer } from "./bun-container.ts";

/**
 * Durable Object backing one bun-baseline container instance. `boot()` measures
 * cold-start until the `Bun.serve` HTTP server answers on its TCP port — the
 * time to usable service.
 */
export class BunObject extends Cloudflare.DurableObject<BunObject>()(
  "BenchBunObject",
  Effect.gen(function* () {
    const container = yield* BunContainer;

    return Effect.gen(function* () {
      const { fetch } = yield* container.getTcpPort(8080);

      return {
        boot: () =>
          Effect.gen(function* () {
            const start = yield* Effect.sync(() => Date.now());
            yield* fetch(HttpClientRequest.get("http://container/")).pipe(
              Effect.flatMap((r) => r.text),
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
      Cloudflare.Containers.layer(BunContainer, {
        enableInternet: true,
      }),
    ),
  ),
) {}
