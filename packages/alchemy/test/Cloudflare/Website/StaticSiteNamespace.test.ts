import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Stack from "@/Stack.ts";
import { Stage } from "@/Stage.ts";
import { inMemoryState, type State } from "@/State";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const { test } = Test.make({
  providers: Layer.empty,
  state: inMemoryState(),
});

// A resource declared once, at module scope, and referenced from a site's
// `env` — the pattern `examples/cloudflare-tanstack` uses.
const Cache = Cloudflare.KV.Namespace("Cache", {});

/** Compile the stack and return the FQN of every registered resource. */
const fqns = <A, Err = never, Req = never>(
  effect: Effect.Effect<A, Err, Req>,
): Effect.Effect<string[], Err, State> =>
  effect.pipe(
    // @ts-expect-error - Stack.make's typing erases R unsoundly here
    Stack.make({
      name: "test",
      providers: Layer.empty,
      state: inMemoryState(),
    }),
    Effect.provideService(Stage, "test"),
    Effect.map((stack: Stack.CompiledStack) =>
      Object.keys(stack.resources).sort(),
    ),
  );

test(
  "StaticSite declares env resources in the caller's namespace",
  Effect.gen(function* () {
    const keys = yield* fqns(
      Effect.gen(function* () {
        yield* Cache;
        yield* Cloudflare.Website.StaticSite("Site", {
          command: "echo build",
          outdir: "dist",
          main: "./worker.ts",
          env: { CACHE: Cache },
        });
      }),
    );
    // Only the build sub-resource is namespaced; the Worker is the site
    // itself and `Cache` stays where the caller declared it.
    expect(keys).toEqual(["Cache", "Site", "Site/Build"]);
  }),
);

test(
  "Vite declares env resources in the caller's namespace",
  Effect.gen(function* () {
    const keys = yield* fqns(
      Effect.gen(function* () {
        yield* Cache;
        yield* Cloudflare.Website.Vite("Site", {
          main: "./worker.ts",
          env: { CACHE: Cache },
        });
      }),
    );
    expect(keys).toEqual(["Cache", "Site"]);
  }),
);
