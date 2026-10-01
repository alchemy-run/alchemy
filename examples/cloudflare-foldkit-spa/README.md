# cloudflare-foldkit-spa

The counter scaffold from `create-foldkit-app --rendering spa --example counter`.
HTML contains an empty app container; `Runtime.run` renders it in the browser.
Cloudflare serves the same shell for deep links.

## Run on Cloudflare

From this directory, after installing the workspace dependencies:

```sh
pnpm dev
pnpm deploy
pnpm destroy
```

`pnpm build` runs the standard Vite build. `pnpm test` runs the credentialed
Cloudflare integration checks and destroys the example afterward.

`alchemy.run.ts` uses `Cloudflare.Website.Foldkit`. The application’s Vite plugin
supplies the build output and routing metadata; no hand-written Worker wrapper
or build identity declaration is required.

## Scaffold source

Application files come from [Foldkit’s generator and examples](https://github.com/foldkit/foldkit/tree/24f1c43eaaf74a83b6e338d72ba98422b7ac8ec4/examples/counter)
(`create-foldkit-app` 0.36.0, Foldkit 0.164.0). They were produced using the
generator’s `createProject` function. Alchemy adds the deployment file, workspace
package configuration and integration tests.

## Rendering examples

- [SPA / CSR](../cloudflare-foldkit-spa): browser-only counter.
- [SSG](../cloudflare-foldkit-ssg): prerendered home and about pages.
- [SSR](../cloudflare-foldkit-ssr): cookie-backed request rendering.
- [Hybrid](../cloudflare-foldkit-hybrid): prerendered pages and a dynamic counter.
