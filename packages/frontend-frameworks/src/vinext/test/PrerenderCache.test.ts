import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as NodePath from "node:path";
import { describe, expect, it } from "vitest";
import { _prerenderCacheForTests } from "../PrerenderCache.ts";

const { loadUpstreamBuildPrerenderKVPairs, toAlchemyPair } =
  _prerenderCacheForTests;

/** Example that declares `@vinext/cloudflare` — same resolve root deploy uses. */
const exampleRoot = NodePath.resolve(
  import.meta.dirname,
  "../../../../../examples/cloudflare-website-vinext",
);

const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));

describe("vinext PrerenderCache upstream delegate", () => {
  it("loads buildPrerenderKVPairs from the project's @vinext/cloudflare", async () => {
    const buildPrerenderKVPairs = await run(
      loadUpstreamBuildPrerenderKVPairs(exampleRoot),
    );
    expect(typeof buildPrerenderKVPairs).toBe("function");

    const empty = buildPrerenderKVPairs(
      NodePath.join(exampleRoot, "dist", "server-missing"),
    );
    expect(empty).toEqual({ routeCount: 0, pairs: [] });
  });

  it("maps upstream expiration_ttl to expirationTtl", () => {
    expect(
      toAlchemyPair({
        key: "cache:page",
        value: "{}",
        expiration_ttl: 2592000,
        metadata: { tags: ["a"] },
      }),
    ).toEqual({
      key: "cache:page",
      value: "{}",
      expirationTtl: 2592000,
      metadata: { tags: ["a"] },
    });
  });
});
