import * as Cloudflare from "alchemy-effect/Cloudflare";
import * as Stack from "alchemy-effect/Stack";
import * as Effect from "effect/Effect";

const stack = Effect.gen(function* () {
  const worker = yield* Cloudflare.StaticSite("Website", {
    main: "./src/worker.ts",
    command: "vite build",
    dev: {
      command: "vite dev",
    },
    outdir: "./dist",
    hash: ["src/**", "index.html", "vite.config.ts", "bun.lock"],
    compatibility: {
      date: "2026-03-16",
      flags: ["nodejs_compat"],
    },
  });

  return {
    url: worker.url,
  };
}).pipe(Stack.make("CloudflareVite", Cloudflare.providers()));

export default stack;
