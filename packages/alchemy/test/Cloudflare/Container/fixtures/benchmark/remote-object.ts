import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

/**
 * Non-Effect ("remote image") container for the benchmark: Alchemy pulls a
 * pre-built public image and re-pushes it — no Effect program is bundled and
 * no runtime is injected. `mendhak/http-https-echo` serves on port 8080 and
 * writes to its inherited stdout fd directly, so it boots cleanly inside
 * Cloudflare's container sandbox.
 */
export class BenchRemoteContainer extends Cloudflare.Container<BenchRemoteContainer>()(
  "BenchRemoteContainer",
  {
    image: "mendhak/http-https-echo:latest",
    // Match wrangler's config exactly (max_instances 100, instance_type lite).
    maxInstances: 100,
    instanceType: "lite",
    instances: 0,
  },
) {}

/**
 * Durable Object backing one remote (non-effectful) container instance.
 * `boot()` measures the time, from inside the DO, until the container's HTTP
 * server answers on its TCP port — the first `fetch` blocks through cold start
 * (the start layer polls the port until it accepts connections).
 */
export class BenchRemoteObject extends Cloudflare.DurableObject<BenchRemoteObject>()(
  "BenchRemoteObject",
  Effect.gen(function* () {
    const container = yield* BenchRemoteContainer;

    return Effect.gen(function* () {
      const { fetch } = yield* container.getTcpPort(8080);

      return {
        boot: () =>
          Effect.gen(function* () {
            const start = yield* Effect.sync(() => Date.now());
            const response = yield* fetch(
              HttpClientRequest.get("http://container/"),
            );
            yield* response.text;
            const end = yield* Effect.sync(() => Date.now());
            return { ms: end - start };
          }),
      };
    });
  }).pipe(
    Effect.provide(
      Cloudflare.Containers.layer(BenchRemoteContainer, {
        enableInternet: true,
      }),
    ),
  ),
) {}
