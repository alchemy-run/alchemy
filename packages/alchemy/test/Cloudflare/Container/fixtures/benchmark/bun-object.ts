import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

/**
 * Non-Effect container built from a Dockerfile whose base image is the *same*
 * `oven/bun:latest` the effectful variant uses — but with no Effect program
 * bundled, just a raw `Bun.serve`. Comparing this against the effectful
 * variant rules out base-image pull/boot time as the cause of the gap: the
 * remaining difference is the bundled Effect runtime.
 */
export class BenchBunContainer extends Cloudflare.Container<BenchBunContainer>()(
  "BenchBunContainer",
  {
    context: `${import.meta.dirname}/bun-context`,
    // Match wrangler's config exactly: max_instances 100 (Alchemy defaults to
    // 1) and instance_type "lite" (Alchemy/API default differs), so the
    // comparison isolates the framework rather than the instance tier.
    maxInstances: 100,
    instanceType: "lite",
    // wrangler deploys containers with `instances: 0` (pure scale-from-zero);
    // Alchemy defaults to 1 (an always-on rollout) which can contend with
    // on-demand starts. Match wrangler.
    instances: 0,
  },
) {}

/**
 * Durable Object backing one bun-baseline container instance. `boot()` times
 * cold-start until the `Bun.serve` HTTP server answers on its TCP port.
 */
export class BenchBunObject extends Cloudflare.DurableObject<BenchBunObject>()(
  "BenchBunObject",
  Effect.gen(function* () {
    const container = yield* BenchBunContainer;

    return Effect.gen(function* () {
      const { fetch } = yield* container.getTcpPort(8080);

      return {
        boot: () =>
          Effect.gen(function* () {
            const start = yield* Effect.sync(() => Date.now());
            // Retry until reachable so the first post-deploy boot records the
            // true cold start (image distribution + start) instead of failing
            // while the image is still landing on the edge metal.
            yield* fetch(HttpClientRequest.get("http://container/")).pipe(
              Effect.flatMap((r) => r.text),
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
      Cloudflare.Containers.layer(BenchBunContainer, {
        enableInternet: true,
      }),
    ),
  ),
) {}
