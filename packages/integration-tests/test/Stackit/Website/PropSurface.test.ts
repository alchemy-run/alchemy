import * as Website from "@alchemy.run/stackit/Website";
import {
  cacheControlFor,
  contentTypeFor,
  isHashedAsset,
  objectKeysOf,
  urlPathsOf,
} from "@alchemy.run/stackit/Website/internal";
import { describe, expect, it } from "@alchemy.run/test";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const tags = { tags: ["unit", "provider:stackit", "provider:stackit:website", "local"] };

const constructors = [
  "Astro",
  "Foldkit",
  "Nextjs",
  "Nuxt",
  "Octane",
  "ReactRouter",
  "SolidStart",
  "StaticSite",
  "SvelteKit",
  "TanStackStart",
  "Vinext",
  "Vite",
  "Vocs",
  "Waku",
] as const;

// Compiled, never run: the type-checker holds the prop surface.
const registry = { repository: "ghcr.io/my-org/web" };
export const contracts = [
  () => Website.Vite("Web", { vite: { outDir: "build", base: "/docs/" } }),
  () =>
    Website.Vite("Web", {
      origin: "function",
      registry,
      assets: { notFoundHandling: "single-page-application" },
    }),
  () => Website.Astro("Web", { astro: { output: "static" } }),
  () => Website.Foldkit("Web", { output: "server", registry }),
  () =>
    Website.Nextjs("Web", {
      registry,
      pullCredential: "credential",
      function: { name: "web", plan: "f2", concurrency: 50, maxScale: 10, keepRevisions: 2 },
    }),
  () => Website.Nuxt("Web", { registry, nuxt: { app: { baseURL: "/docs/" } } }),
  () => Website.SvelteKit("Web", { registry, kit: { paths: { base: "/docs" } } }),
  () => Website.Waku("Web", { registry, waku: { srcDir: "src" } }),
  () => Website.Vocs("Docs", { registry, outDir: "build" }),
  () => Website.Vinext("Web", { registry }),
  () => Website.Octane("Web", { registry, invalidation: false }),
  () => Website.ReactRouter("Web", { registry, invalidation: { paths: "all" } }),
  () => Website.SolidStart("Web", { registry, cdn: { regions: ["EU", "US"] } }),
  () =>
    Website.TanStackStart("Web", {
      registry,
      domain: { name: "www.example.com", certificate: { type: "managed" } },
      tags: { team: "web" },
    }),
  () => Website.StaticSite("Web", { command: "hugo", outdir: "public", domain: "www.example.com" }),
  () =>
    Website.StaticSite("Web", {
      command: "hugo",
      outdir: "public",
      // @ts-expect-error A static site has no server, so no image to push.
      registry,
    }),
  () =>
    Website.StaticSite("Web", {
      command: "hugo",
      outdir: "public",
      // @ts-expect-error The composition owns the origin.
      cdn: { backend: { type: "http", originUrl: "https://example.com" } },
    }),
  () =>
    Website.Vite("Web", {
      // @ts-expect-error SPA behavior belongs in assets.notFoundHandling.
      spa: true,
    }),
];

describe("Stackit.Website", () => {
  it(
    "exports every framework composite",
    () => {
      for (const name of constructors) expect(typeof Website[name]).toBe("function");
    },
    tags,
  );

  it(
    "treats only hash-shaped names in build-asset directories as content-hashed",
    () => {
      for (const hashed of [
        "assets/index-DiwrgTda.js",
        "assets/entry.a1b2c3d4.css",
        "_astro/client.BxY12_-a.js",
        "assets/index-B_xY-12a.js",
        "_nuxt/BxY12_-a.js",
        "_build/assets/index-Abcd1234.js",
        "_app/immutable/chunks/x.js",
        "_next/static/chunks/main.js",
      ]) {
        expect(isHashedAsset(hashed)).toBe(true);
      }
      for (const plain of [
        "index.html",
        "sw.js",
        "manifest.webmanifest",
        "apple-touch-icon-180x180.png",
        "assets/logo.png",
        "assets/my-component.js",
        "_app/version.json",
        "_nuxt/builds/latest.json",
        "assets/TeamPhoto.png",
        "assets/site-main-2.css",
        "assets/hero-image-12.png",
        "assets/photo-20240115.jpg",
        "assets/hero-Homepage.png",
      ]) {
        expect(isHashedAsset(plain)).toBe(false);
      }
    },
    tags,
  );

  it(
    "caches hashed files for good, never caches HTML, and revalidates the rest",
    () => {
      expect(cacheControlFor("assets/index-DiwrgTda.js")).toContain("immutable");
      expect(cacheControlFor("index.html")).toContain("no-store");
      expect(cacheControlFor("about/index.html")).toContain("no-store");
      expect(cacheControlFor("sw.js")).toBe("public,max-age=0,must-revalidate");
    },
    tags,
  );

  it(
    "types what core's table leaves out, and defers to it for the rest",
    () => {
      expect(contentTypeFor("sitemap.xml")).toBe("application/xml");
      expect(contentTypeFor("site.webmanifest")).toBe("application/manifest+json");
      expect(contentTypeFor("index.html")).toBe("text/html; charset=utf-8");
      expect(contentTypeFor("data.bin")).toBe("application/octet-stream");
    },
    tags,
  );

  it(
    "stores a page at the URLs frameworks link to",
    () => {
      expect(objectKeysOf("index.html", {})).toEqual(["index.html"]);
      expect(objectKeysOf("about/index.html", {})).toEqual(["about/index.html", "about", "about/"]);
      expect(objectKeysOf("about.html", {})).toEqual(["about.html"]);
      expect(objectKeysOf("about.html", { htmlHandling: "drop-trailing-slash" })).toEqual([
        "about.html",
        "about",
      ]);
      expect(objectKeysOf("index.html", { prefix: "/docs/" })).toEqual([
        "docs/index.html",
        "docs",
        "docs/",
      ]);
    },
    tags,
  );

  it(
    "purges every URL a file is served at",
    () => {
      expect(urlPathsOf("index.html", {})).toEqual(["/", "/index.html"]);
      expect(urlPathsOf("about/index.html", {})).toEqual([
        "/about/index.html",
        "/about",
        "/about/",
      ]);
      expect(urlPathsOf("robots.txt", {})).toEqual(["/robots.txt"]);
      expect(urlPathsOf("index.html", { prefix: "docs" })).toEqual([
        "/docs/",
        "/docs/index.html",
        "/docs",
        "/docs/",
      ]);
    },
    tags,
  );

  it(
    "keeps a Redacted value out of a production build, and gives it to the dev server",
    () => {
      const env = { PUBLIC: "visible", SECRET: Redacted.make("hidden") };
      expect(Website.websiteBuildEnv(env, false)).toEqual({ PUBLIC: "visible" });
      expect(Website.websiteBuildEnv(env, true)).toEqual({ PUBLIC: "visible", SECRET: "hidden" });
      expect(Website.websiteBuildEnv(undefined, false)).toBeUndefined();
    },
    tags,
  );

  it(
    "applies the same rule to a value that only resolves to a Redacted later",
    () => {
      const env = {
        SECRET: Effect.succeed(Redacted.make("hidden")),
        PUBLIC: Effect.succeed("visible"),
      };
      const production = Website.websiteBuildEnv(env, false)!;
      expect(Effect.runSync(production.SECRET)).toBeUndefined();
      expect(Effect.runSync(production.PUBLIC)).toEqual("visible");
      const dev = Website.websiteBuildEnv(env, true)!;
      expect(Effect.runSync(dev.SECRET)).toEqual("hidden");
      // An Output stays an Output, for the engine to resolve.
      const output = Output.literal(Redacted.make("hidden"));
      expect(Output.isOutput(Website.websiteBuildEnv({ SECRET: output }, false)!.SECRET)).toBe(
        true,
      );
    },
    tags,
  );
});
