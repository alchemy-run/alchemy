import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "AlchemyEffectWebsite",
  {
    providers: Cloudflare.providers(),
  },
  Effect.gen(function* () {
    const Website = yield* Cloudflare.StaticSite("Website", {
      command: "bun astro build",
      main: "./src/worker.ts",
      outdir: "dist",
      memo: {
        include: ["src/**", "astro.config.mjs", "package.json", "../bun.lock"],
      },
      compatibility: {
        date: "2026-04-02",
        flags: ["nodejs_compat"],
      },
    });

    return {
      url: Website.url,
    };
  }),
);
