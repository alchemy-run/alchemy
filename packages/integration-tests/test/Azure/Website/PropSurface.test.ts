import * as Azure from "@alchemy.run/azure";
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
          tags: { team: "web" },
          location: "eastus",
          instanceMemoryMB: 4096,
          maximumInstanceCount: 40,
          frontDoor: {},
        }),
      () =>
        Azure.Website.Vite("V", {
          // @ts-expect-error Front Door is on by default; only `false` opts out
          frontDoor: true,
        }),
      () =>
        Azure.Website.Vite("V", {
          // @ts-expect-error server builds run on Flex Consumption, not an App Service plan
          sku: "B1",
        }),
      () => Azure.Website.Vite("V", { frontDoor: false }),
      () =>
        Azure.Website.Vite("V", {
          frontDoor: { profile: Azure.Cdn.Profile("Edge") },
        }),
      () =>
        Azure.Website.Vite("V", {
          // @ts-expect-error custom domains attach through Front Door, not a prop
          domain: "app.example.com",
        }),
      () =>
        Azure.Website.Foldkit("F", {
          output: "static",
          vite: { base: "/" },
          assets: { notFoundHandling: "404-page" },
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
          frontDoor: false,
        }),
    ];

    it("pins the shared Azure website props at the type level", () => {
      expect(_pins.length).toBeGreaterThan(0);
    });
  },
);
