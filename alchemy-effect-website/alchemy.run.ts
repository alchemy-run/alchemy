import * as Cloudflare from "alchemy-effect/Cloudflare";
import * as Stack from "alchemy-effect/Stack";
import * as Effect from "effect/Effect";

const stack = Effect.gen(function* () {
  const site = yield* Cloudflare.StaticSite("Website", {
    main: "./src/worker.ts",
    command: "bun run build",
    dev: {
      command: "bun run dev:site",
    },
    outdir: "./public",
    hash: [
      "./config.toml",
      "./content/**",
      "./src/**",
      "./static/**",
      "./templates/**",
      "./package.json",
      "../scripts/generate-api-reference.ts",
      "../alchemy-effect/src/**",
      "../bun.lock",
    ],
    assetsConfig: {
      runWorkerFirst: true,
    },
    compatibility: {
      date: "2026-04-02",
      flags: ["nodejs_compat"],
    },
  });

  return {
    url: site.url,
  };
}).pipe(Stack.make("AlchemyEffectWebsite", Cloudflare.providers()));

export default stack;
