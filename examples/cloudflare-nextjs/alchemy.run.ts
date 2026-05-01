import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

// Deploy a Next.js app via OpenNext + Cloudflare Workers, exercising
// the `bundle: false` code path on `Cloudflare.Worker`.
//
// `.open-next/worker.js` is a complete, runtime-ready ESM bundle
// produced by `@opennextjs/cloudflare`. Re-running it through
// alchemy's rolldown step rewrites the dynamic `import()` calls that
// OpenNext relies on, which makes the deploy fail Cloudflare's
// validation step with:
//
//   UnknownCloudflareError: Uncaught TypeError: Cannot destructure
//   property 'name' of '(intermediate value)' as it is undefined.
//   at worker.js:1:23445 in createGenericHandler
//
// `bundle: false` short-circuits the rolldown step and uploads the
// OpenNext output byte-for-byte, which is what the upstream tool
// expects.
export default Alchemy.Stack(
  "CloudflareNextjsExample",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* Cloudflare.Worker("NextjsWorker", {
      main: ".open-next/worker.js",
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
