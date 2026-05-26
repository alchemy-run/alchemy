import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

// Deploy a Next.js app via OpenNext + Cloudflare Workers, exercising
// the `bundle: false` code path on `Cloudflare.Worker`.
//
// `@opennextjs/cloudflare` emits `.open-next/worker.js` plus sibling
// modules. Wrangler's dry-run bundle step then applies the same
// Cloudflare compatibility transforms it uses for deploys and writes a
// single runtime-ready worker to `.open-next-bundled/worker.js`.
//
// `bundle: false` short-circuits alchemy's rolldown step and uploads
// that externally produced worker byte-for-byte.
export default Alchemy.Stack(
  "CloudflareNextjsExample",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* Cloudflare.Worker("NextjsWorker", {
      main: ".open-next-bundled/worker.js",
      bundle: false,
      assets: {
        directory: ".open-next/assets",
        config: {
          notFoundHandling: "none",
          htmlHandling: "auto-trailing-slash",
          runWorkerFirst: false,
        },
      },
      compatibility: {
        // OpenNext (via Next.js's edge runtime) imports `node:perf_hooks`
        // transitively. Cloudflare started providing it natively on
        // 2026-03-17; earlier dates throw "No such module" at request
        // time and would mask the bundling behavior we want to exercise.
        date: "2026-03-17",
        flags: [
          "nodejs_compat",
          "nodejs_compat_populate_process_env",
          "global_fetch_strictly_public",
        ],
      },
      subdomain: { enabled: true },
    });

    return {
      url: worker.url,
    };
  }),
);
