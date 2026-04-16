import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

export type WorkerEnv = Cloudflare.InferEnv<typeof Website>;

const Website = Cloudflare.StaticSite("Website", {
  command: "bun astro build",
  main: "./src/worker.ts",
  outdir: "dist",
  domain: "v2.alchemy-test-3.us",
  memo: {
    include: ["src/**", "astro.config.mjs", "package.json", "../bun.lock"],
  },
  compatibility: {
    date: "2026-04-02",
    flags: ["nodejs_compat"],
  },
  assetsConfig: {
    runWorkerFirst: true,
  },
});

export default Alchemy.Stack(
  "AlchemyEffectWebsite",
  {
    providers: Cloudflare.providers(),
  },
  Effect.gen(function* () {
    const website = yield* Website;

    return {
      url: website.url,
    };
  }),
);
