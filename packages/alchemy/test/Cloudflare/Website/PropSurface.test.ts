import * as Cloudflare from "@/Cloudflare/index.ts";
import { describe, expect, it } from "alchemy-test";

/**
 * Compile-time pins for the framework Website resources' prop surfaces.
 *
 * The resources deliberately reject the Worker props their source dispatch
 * owns (`script`, `bundle`, `source`, `vite`, `assets` where the framework
 * owns assets) — passing one used to type-check and only fail at runtime
 * inside `resolveSource`. These `@ts-expect-error` pins fail the build if
 * an `Omit` is ever loosened again. The `() => {}` bodies never run; only
 * the types matter.
 */
describe("Website prop surfaces", () => {
  const _pins = [
    () =>
      Cloudflare.Website.Waku("W", {
        // @ts-expect-error `script` is owned by the source dispatch
        script: "export default {}",
      }),
    () =>
      Cloudflare.Website.Waku("W", {
        // @ts-expect-error `bundle` is owned by the source dispatch
        bundle: false,
      }),
    () =>
      Cloudflare.Website.SvelteKit("S", {
        // @ts-expect-error `script` is owned by the source dispatch
        script: "export default {}",
      }),
    () =>
      Cloudflare.Website.SvelteKit("S", {
        // @ts-expect-error `main` is not supported (no custom-entry seam)
        main: "worker.ts",
      }),
    () =>
      Cloudflare.Website.Nuxt("N", {
        // @ts-expect-error `bundle` is owned by the source dispatch
        bundle: false,
      }),
    () =>
      Cloudflare.Website.Astro("A", {
        // @ts-expect-error `main` is not supported (no custom-entry seam)
        main: "worker.ts",
      }),
    () =>
      Cloudflare.Website.Octane("O", {
        // @ts-expect-error `main` is not supported (no custom-entry seam)
        main: "worker.ts",
      }),
    () =>
      Cloudflare.Website.Octane("O", {
        // @ts-expect-error `script` is owned by the source dispatch
        script: "export default {}",
      }),
    () =>
      Cloudflare.Website.Astro("A", {
        // @ts-expect-error `source` is owned by the resource itself
        source: { provider: "x", options: {} },
      }),
    () =>
      Cloudflare.Website.Astro("A", {
        prerenderEnvironment: "node",
      }),
    () =>
      Cloudflare.Website.Astro("A", {
        prerenderEnvironment: "workerd",
      }),
    () =>
      Cloudflare.Website.Astro("A", {
        // @ts-expect-error only workerd and node are supported
        prerenderEnvironment: "bun",
      }),
    () =>
      Cloudflare.Website.Nextjs("X", {
        // @ts-expect-error `script` is owned by the source dispatch
        script: "export default {}",
      }),
    () =>
      Cloudflare.Website.Nextjs("X", {
        // @ts-expect-error `main` is not supported (OpenNext owns the entry)
        main: "worker.ts",
      }),
    () =>
      Cloudflare.Website.Nextjs("X", {
        // @ts-expect-error `source` is owned by the resource itself
        source: { provider: "x", options: {} },
      }),
    () =>
      Cloudflare.Website.Foldkit("F", {
        // @ts-expect-error `script` is owned by the source dispatch
        script: "export default {}",
      }),
    () =>
      Cloudflare.Website.Foldkit("F", {
        // @ts-expect-error `bundle` is owned by the source dispatch
        bundle: false,
      }),
    () =>
      Cloudflare.Website.Foldkit("F", {
        // @ts-expect-error `source` is owned by the resource itself
        source: { provider: "x", options: {} },
      }),
    () =>
      Cloudflare.Website.Foldkit("F", {
        // @ts-expect-error `viteEnvironments` is not supported (Foldkit has no RSC split)
        viteEnvironments: { entry: "rsc", children: ["ssr"] },
      }),
    // `main` IS supported — a Foldkit deployment may carry a custom Worker
    // entry (API routes, error reporting, Durable Objects) alongside the
    // client build. Pinned positively so an `Omit` can't quietly drop it.
    () => Cloudflare.Website.Foldkit("F", { main: "src/worker.ts" }),
    () =>
      Cloudflare.Website.Vocs("Docs", {
        // @ts-expect-error `source` is owned by the Vocs integration
        source: { provider: "x", options: {} },
      }),
    () =>
      Cloudflare.Website.Vocs("Docs", {
        // @ts-expect-error Vocs owns its Waku/RSC worker entry
        main: "worker.ts",
      }),
    // ── Flat-props doctrine pins ─────────────────────────────────────
    // Framework-named config bags are dissolved into flat, explicitly
    // typed props; the shared vocabulary (`outDir`, `spa`, `errorPage`)
    // is identical across composites. These pins fail the build if a bag
    // sneaks back in or a flat prop is dropped.
    () =>
      Cloudflare.Website.Astro("A", {
        // @ts-expect-error the `astro` config bag is dissolved into flat props
        astro: { output: "static" },
      }),
    () =>
      Cloudflare.Website.Astro("A", {
        output: "static",
        site: "https://example.com",
        srcDir: "./app",
        outDir: "./dist",
        errorPage: "404.html",
      }),
    () =>
      Cloudflare.Website.Astro("A", {
        // @ts-expect-error Cloudflare serves the nearest `404.html` — the name is fixed
        errorPage: "not-found.html",
      }),
    () =>
      Cloudflare.Website.Nextjs("X", {
        // @ts-expect-error the `nextjs` config bag is dissolved into flat props
        nextjs: { devMode: "hmr" },
      }),
    () =>
      Cloudflare.Website.Nextjs("X", {
        devMode: "hmr",
        buildCommand: "npx next build",
        minify: true,
        skipNextBuild: false,
        configPath: "open-next.config.ts",
        debug: false,
      }),
    () =>
      Cloudflare.Website.Nuxt("N", {
        // @ts-expect-error open `nuxt` passthrough removed — config belongs in nuxt.config.ts
        nuxt: { routeRules: {} },
      }),
    () =>
      Cloudflare.Website.SvelteKit("S", {
        // @ts-expect-error open `kit` passthrough removed — config belongs in the sveltekit() call
        kit: { alias: {} },
      }),
    // `adapter` survives — a cohesive single-feature object, not a junk
    // drawer.
    () =>
      Cloudflare.Website.SvelteKit("S", {
        adapter: { notFoundHandling: "404-page", fallback: "spa" },
      }),
    () =>
      Cloudflare.Website.Waku("W", {
        // @ts-expect-error renamed to the shared flat `outDir`
        distDir: "build",
      }),
    () => Cloudflare.Website.Waku("W", { outDir: "build" }),
    () =>
      Cloudflare.Website.Vite("V", {
        // No spa/errorPage sugar on CF Vite: Workers Assets' own
        // notFoundHandling is the platform-native surface.
        assets: { notFoundHandling: "single-page-application" },
      }),
    () =>
      Cloudflare.Website.Vite("V", {
        // @ts-expect-error spa sugar deliberately not offered on CF Vite
        spa: true,
      }),
    () => Cloudflare.Website.Foldkit("F", { spa: false }),
    () => Cloudflare.Website.Foldkit("F", { errorPage: "404.html" }),
  ];

  it("rejects source-dispatch props at the type level", () => {
    // The pins above are compile-time only.
    expect(_pins.length).toBeGreaterThan(0);
  });
});
