import * as Cloudflare from "@/Cloudflare/index.ts";
import { isHyperdriveConnection } from "@/Cloudflare/Hyperdrive/Connection.ts";
import { isNamespace } from "@/Cloudflare/KV/Namespace.ts";
import { isIndex } from "@/Cloudflare/Vectorize/VectorizeIndex.ts";
import * as Output from "@/Output.ts";
import { isResource } from "@/Resource.ts";
import * as Test from "@/Test/Vitest";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expectUrlContains } from "../Utils/Http.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

/**
 * `Resource.ref(...)` values must classify exactly like locally-declared
 * resources wherever code duck-types on `.Type` — most importantly the
 * Worker `env` binding classifiers. A ref used to answer `.Type` with an
 * Output expression, so the guard failed and the ref silently degraded
 * to a plain JSON env var instead of the native binding.
 */
describe("ref classification", () => {
  it("a ref answers .Type with the target's literal resource type", () => {
    const ref = Effect.runSync(Cloudflare.KV.Namespace.ref("SomeNamespace"));
    expect(ref.Type).toBe("Cloudflare.KV.Namespace");
    expect(isNamespace(ref)).toBe(true);
  });

  it("previously `in`-based guards accept refs too", () => {
    expect(
      isHyperdriveConnection(
        Effect.runSync(Cloudflare.Hyperdrive.Connection.ref("SomeConnection")),
      ),
    ).toBe(true);
    expect(
      isIndex(Effect.runSync(Cloudflare.Vectorize.Index.ref("SomeIndex"))),
    ).toBe(true);
  });

  it("guards still reject refs to other resource types", () => {
    const ref = Effect.runSync(Cloudflare.Hyperdrive.Connection.ref("Conn"));
    expect(isNamespace(ref)).toBe(false);
  });

  it("a ref still routes through Output resolution, not upstream lookup", () => {
    const ref = Effect.runSync(Cloudflare.KV.Namespace.ref("SomeNamespace"));
    // `isResource` uses `"Type" in value`, which must stay false for
    // refs — otherwise `evaluate` would treat them as locally-declared
    // resources and fail with MissingSourceError.
    expect(isResource(ref)).toBe(false);
    // Attributes are still deploy-time Outputs, not literals.
    expect(Output.isOutput(ref.namespaceId)).toBe(true);
  });
});

const script = `export default {
  async fetch(request, env) {
    await env.KV.put("ref-binding-key", "bound-through-ref");
    const value = await env.KV.get("ref-binding-key");
    return new Response(value ?? "missing");
  },
};`;

test.provider(
  "a KV namespace ref in worker env produces a working native binding",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Phase 1: the target must already be in state for the ref to
      // resolve (a ghost ref fails the plan).
      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.KV.Namespace("RefNamespace");
        }),
      );

      // Phase 2: bind the namespace via `Namespace.ref(...)`. If the
      // ref misclassifies, no kv_namespace binding is emitted, the
      // worker still deploys, and `env.KV.put` throws at runtime — so
      // a live KV roundtrip is the airtight assertion.
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const namespace = yield* Cloudflare.KV.Namespace("RefNamespace");
          const worker = yield* Cloudflare.Worker("ref-binding-worker", {
            script,
            subdomain: { enabled: true },
            env: {
              KV: yield* Cloudflare.KV.Namespace.ref("RefNamespace"),
            },
          });
          return { namespace, worker };
        }),
      );

      yield* expectUrlContains(deployed.worker.url!, "bound-through-ref", {
        label: "ref-bound KV worker",
      });

      yield* stack.destroy();
    }),
  { timeout: 240_000 },
);
