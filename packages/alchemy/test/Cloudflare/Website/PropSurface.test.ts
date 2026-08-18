import * as Cloudflare from "@/Cloudflare/index.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

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

  // Effectful (impl) arm pins. The no-impl arms above stay byte- and
  // type-compatible; the 3-argument arms accept an Effect program, require
  // the `main` module anchor, and accept the `server` routing options.
  const okImpl = Effect.succeed({
    fetch: Effect.succeed(HttpServerResponse.text("ok")),
  });

  const _implPins = [
    // plain form: `main` anchor + `server` options accepted
    () =>
      Cloudflare.Website.Vite(
        "V",
        {
          main: "src/site.ts",
          server: { entry: "./server.ts", verify: false },
        },
        okImpl,
      ),
    // constructs without a custom-entry seam gain `main` ONLY on the impl
    // arm (it anchors the program's module, not a worker entry)
    () =>
      Cloudflare.Website.Astro(
        "A",
        { main: "src/site.ts", server: { verify: false } },
        okImpl,
      ),
    () => Cloudflare.Website.SvelteKit("S", { main: "src/site.ts" }, okImpl),
    () => Cloudflare.Website.Nextjs("X", { main: "src/site.ts" }, okImpl),
    () => Cloudflare.Website.Nuxt("N", { main: "src/site.ts" }, okImpl),
    () => Cloudflare.Website.Waku("W", { main: "src/site.ts" }, okImpl),
    () => Cloudflare.Website.Octane("O", { main: "src/site.ts" }, okImpl),
    // curried-class form
    () => {
      class Site extends Cloudflare.Website.Vite<Site>()(
        "Site",
        { main: "src/site.ts", server: { verify: true } },
        okImpl,
      ) {}
      return Site;
    },
    () => {
      class Site extends Cloudflare.Website.Astro<Site>()(
        "Site",
        { main: "src/site.ts" },
        okImpl,
      ) {}
      return Site;
    },
    // the anchor is REQUIRED with an impl
    () =>
      Cloudflare.Website.Astro(
        "A",
        // @ts-expect-error `main` is required with an Effect program
        {},
        okImpl,
      ),
    () =>
      Cloudflare.Website.Vite(
        "V",
        // @ts-expect-error `main` is required with an Effect program
        { server: { verify: true } },
        okImpl,
      ),
    // source-dispatch props stay rejected on the impl arm too
    () =>
      Cloudflare.Website.Waku(
        "W",
        // @ts-expect-error `script` is owned by the source dispatch
        { main: "src/site.ts", script: "export default {}" },
        okImpl,
      ),
  ];

  it("rejects source-dispatch props at the type level", () => {
    // The pins above are compile-time only.
    expect(_pins.length).toBeGreaterThan(0);
    expect(_implPins.length).toBeGreaterThan(0);
  });
});
