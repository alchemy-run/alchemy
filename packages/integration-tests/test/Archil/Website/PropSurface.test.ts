import * as Archil from "@alchemy.run/archil";
import { describe, expect, it } from "@alchemy.run/test";

describe(
  "Archil.Website prop surfaces",
  { tags: ["unit", "provider:archil", "provider:archil:website", "local"] },
  () => {
    const _pins = [
      () =>
        Archil.Website.Vinext("Vinext", {
          rootDir: "./app",
          env: { GREETING: "Hello" },
          memo: { lockfile: true },
          assets: { notFoundHandling: "404-page" },
          dev: {},
          sandbox: { vcpuCount: 2, idleTtlSeconds: 0 },
        }),
      () =>
        Archil.Website.Vite("V", {
          // @ts-expect-error Archil sites have no custom domains (hostnames are *.archil.app)
          domain: "app.example.com",
        }),
      () =>
        Archil.Website.Vite("V", {
          assets: { notFoundHandling: "single-page-application" },
          vite: { outDir: "build" },
        }),
      () =>
        Archil.Website.Vite("V", {
          // @ts-expect-error spa sugar replaced by assets.notFoundHandling
          spa: true,
        }),
      () =>
        Archil.Website.Waku("W", {
          waku: { srcDir: "app" },
        }),
      () =>
        Archil.Website.Waku("W", {
          // @ts-expect-error srcDir lives on the waku bag
          srcDir: "app",
        }),
      () =>
        Archil.Website.Astro("A", {
          astro: { output: "static" },
          assets: { notFoundHandling: "404-page" },
        }),
      () =>
        Archil.Website.Nuxt("N", {
          nuxt: { app: { baseURL: "/docs/" } },
        }),
      () =>
        Archil.Website.SvelteKit("S", {
          kit: { paths: { base: "/docs" } },
        }),
    ];

    it("rejects dissolved 1353 props at the type level", () => {
      expect(_pins.length).toBeGreaterThan(0);
    });
  },
);
