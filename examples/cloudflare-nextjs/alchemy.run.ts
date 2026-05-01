import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

// Deploy a Next.js app via OpenNext + Cloudflare Workers using the
// in-process bundler (`Cloudflare.OpenNext`).
//
// `Cloudflare.OpenNext` runs `next build && opennextjs-cloudflare build`
// to produce `.open-next/`, then bundles the worker entry in-process
// with esbuild + `@cloudflare/unenv-preset` + the vendored
// `nodejsHybridPlugin` (the same building blocks wrangler uses
// internally), and uploads the result via `Cloudflare.Worker` with
// `bundle: false`. No `wrangler` subprocess is involved.
//
// To compare against the wrangler-subprocess variant, swap `OpenNext`
// for `OpenNextWranglerSubprocess` below — the contract is identical.
export default Alchemy.Stack(
  "CloudflareNextjsExample",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const app = yield* Cloudflare.OpenNextWranglerSubprocess("NextjsApp", {
      compatibility: {
        // OpenNext (via Next.js's edge runtime) imports
        // `node:perf_hooks` transitively. Cloudflare started providing
        // it natively on 2026-03-17; earlier dates throw "No such
        // module" at request time.
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
      url: app.url,
    };
  }),
);
