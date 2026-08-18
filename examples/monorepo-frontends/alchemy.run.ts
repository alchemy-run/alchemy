// ONE stack deploying an effectful AWS Website per framework, each built
// from a NESTED workspace package (`rootDir: "packages/<framework>"`) —
// the monorepo shape: a single root alchemy.run.ts, one package per
// frontend framework.
import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";
import AstroSite from "./packages/astro/src/backend.ts";
import NextjsSite from "./packages/nextjs/src/backend.ts";
import NuxtSite from "./packages/nuxt/src/backend.ts";
import SvelteKitSite from "./packages/sveltekit/src/backend.ts";
import TanStackSite from "./packages/tanstack/src/backend.ts";
import ViteSite from "./packages/vite/src/backend.ts";

export default Alchemy.Stack(
  "MonorepoFrontendsExample",
  {
    providers: AWS.providers(),
    state: AWS.state(),
  },
  Effect.gen(function* () {
    // Each Website class (declared in its package's src/backend.ts with
    // its Effect program) is itself the construct — yielding it deploys
    // the site from its nested package root.
    const nextjs = yield* NextjsSite;
    const nuxt = yield* NuxtSite;
    const astro = yield* AstroSite;
    const sveltekit = yield* SvelteKitSite;
    const tanstack = yield* TanStackSite;
    const vite = yield* ViteSite;

    return {
      nextjsUrl: nextjs.url,
      nuxtUrl: nuxt.url,
      astroUrl: astro.url,
      sveltekitUrl: sveltekit.url,
      tanstackUrl: tanstack.url,
      viteUrl: vite.url,
      // The SPA's backend Lambda — in dev, the local emulator address
      // serving /api/* (the Vite dev server only serves the static SPA).
      viteServerUrl: vite.serverUrl,
    };
  }),
);
