import * as Azure from "@/Azure";
import { describe, expect, it } from "alchemy-test";

describe(
  "Azure.Website prop surfaces",
  { tags: ["unit", "provider:azure", "provider:azure:website", "local"] },
  () => {
    const _pins = [
      () =>
        Azure.Website.Vinext("Vinext", {
          rootDir: "./app",
          env: { GREETING: "Hello" },
          memo: { lockfile: true },
          assets: { notFoundHandling: "404-page" },
          dev: {},
          domain: "app.example.com",
          tags: { team: "web" },
          location: "eastus",
        }),
      () =>
        Azure.Website.Vite("V", {
          assets: { notFoundHandling: "single-page-application" },
          vite: { outDir: "build" },
        }),
      () =>
        Azure.Website.Vite("V", {
          // @ts-expect-error spa sugar replaced by assets.notFoundHandling
          spa: true,
        }),
      () =>
        Azure.Website.Vite("V", {
          // @ts-expect-error Hetzner-only prop
          server: "box",
        }),
      () =>
        Azure.Website.Waku("W", {
          waku: { srcDir: "app" },
        }),
      () =>
        Azure.Website.Waku("W", {
          // @ts-expect-error srcDir lives on the waku bag
          srcDir: "app",
        }),
      () =>
        Azure.Website.Astro("A", {
          astro: { output: "static" },
          assets: { notFoundHandling: "404-page" },
        }),
      () =>
        Azure.Website.Nuxt("N", {
          nuxt: { app: { baseURL: "/docs/" } },
        }),
      () =>
        Azure.Website.SvelteKit("S", {
          kit: { paths: { base: "/docs" } },
        }),
      () =>
        Azure.Website.StaticSite("Static", {
          command: "hugo",
          outdir: "public",
          spa: true,
          location: "eastus",
        }),
    ];

    it("pins the shared Azure website props at the type level", () => {
      expect(_pins.length).toBeGreaterThan(0);
    });
  },
);
