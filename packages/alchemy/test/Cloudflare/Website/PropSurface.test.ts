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
  ];

  it("rejects source-dispatch props at the type level", () => {
    // The pins above are compile-time only.
    expect(_pins.length).toBeGreaterThan(0);
  });
});
