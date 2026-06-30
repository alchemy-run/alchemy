import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Minimal Effect-native container used purely for the cold-start benchmark.
 * Alchemy bundles this file's Effect program into a generated image; the DO
 * proxies a trivial `ping()` RPC into it, which is enough to prove the
 * container has started and is accepting connections on its RPC port.
 */
export class BenchEffectfulContainer extends Cloudflare.Container<
  BenchEffectfulContainer,
  {
    ping: () => Effect.Effect<string>;
  }
>()("BenchEffectfulContainer") {}

export default BenchEffectfulContainer.make(
  {
    main: import.meta.filename,
    dockerfile: "FROM oven/bun:latest",
    // Alchemy defaults maxInstances to 1, which serializes every named DO
    // instance through a single container slot. Match wrangler's
    // `max_instances: 100` so the benchmark actually runs concurrently, and
    // `instance_type: "lite"` so we compare the same tier.
    maxInstances: 100,
    instanceType: "lite",
    instances: 0,
  },
  Effect.gen(function* () {
    return {
      ping: () => Effect.succeed("pong"),
      fetch: Effect.succeed(HttpServerResponse.text("ok")),
    };
  }),
);
