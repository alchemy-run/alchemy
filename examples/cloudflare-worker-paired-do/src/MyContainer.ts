/**
 * MyContainer — Container resource declaration ONLY.
 *
 * This file intentionally does NOT call `.make(Effect.gen(...))`. The runtime
 * lives in `./container-runtime/server.ts`. This split is the whole point of
 * the paired-DO pattern — real-world projects put heavy runtime deps (e.g.
 * `sharp`, `impit`, `playwright`) in the dedicated runtime file so the DO-side
 * bundle stays lean and the container bundle is built from a different entry.
 *
 * Note the LogicalId `"MyContainerApp"` — it differs from the DO's LogicalId
 * `"MyContainer"` (see ./MyContainerDO.ts) to avoid a `sid` collision in
 * `Diff.ts`'s last-write-wins binding dedup (see README.md "Why the LogicalIds
 * differ" section). The `className:` is omitted; alchemy derives the actual
 * CF-side DO class name from the TypeScript class name `MyContainer`.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

export class MyContainer extends Cloudflare.Container<
  MyContainer,
  {
    /**
     * Tiny container-side effect: return a greeting.
     * (Kept trivial on purpose — the whole point of this repro is the DO
     * linkage, not the container's work.)
     */
    hello: () => Effect.Effect<string>;
  }
>()("MyContainerApp", {
  // SPLIT RUNTIME: main points to a separate file, NOT `import.meta.filename`.
  // This is the pattern real projects adopt when container runtime has heavy
  // deps that shouldn't be pulled into the DO-side bundle.
  main: "./src/container-runtime/server.ts",
  instanceType: "dev",
  observability: {
    logs: {
      enabled: true,
    },
  },
}) {}
