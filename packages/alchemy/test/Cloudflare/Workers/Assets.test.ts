import { readAssets } from "@/Cloudflare/Workers/Assets.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

// Cloudflare matches request paths against the manifest literally and never
// strips a prefix, so `base` produces the manifest its documented
// subdirectory layout would, without moving the build output on disk.
layer(NodeServices.layer)("readAssets base", (it) => {
  const site = Effect.fnUntraced(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-base-" });
    yield* fs.makeDirectory(path.join(dir, "assets"), { recursive: true });
    yield* fs.writeFileString(path.join(dir, "assets", "app.js"), "app");
    yield* fs.writeFileString(path.join(dir, "index.html"), "<html>");
    yield* fs.writeFileString(path.join(dir, "robots.txt"), "robots");
    yield* fs.writeFileString(path.join(dir, "ignored.txt"), "ignored");
    yield* fs.writeFileString(path.join(dir, ".assetsignore"), "ignored.txt\n");
    yield* fs.writeFileString(path.join(dir, "_headers"), "/docs/*\n  X: y\n");
    yield* fs.writeFileString(path.join(dir, "_redirects"), "/a /docs/b 301\n");
    return dir;
  });

  it.effect("keys the manifest with the base", () =>
    Effect.gen(function* () {
      const directory = yield* site();
      const assets = yield* readAssets({ directory, base: "/docs/" });

      expect(Object.keys(assets.manifest)).toEqual([
        "/docs/assets/app.js",
        "/docs/index.html",
        "/docs/robots.txt",
      ]);
      expect(assets.pathPrefix).toEqual("/docs");
    }),
  );

  it.effect("leaves the manifest at the root without a base", () =>
    Effect.gen(function* () {
      const directory = yield* site();
      const assets = yield* readAssets({ directory });

      expect(Object.keys(assets.manifest)).toEqual([
        "/assets/app.js",
        "/index.html",
        "/robots.txt",
      ]);
      expect(assets.pathPrefix).toEqual("");
    }),
  );

  // "/" and "./" are already the root; an absolute base means a CDN serves
  // the assets, not this Worker.
  it.effect("ignores bases that name no path", () =>
    Effect.gen(function* () {
      const directory = yield* site();
      for (const base of ["/", "./", "//cdn.example.com/", "https://cdn.x/"]) {
        const assets = yield* readAssets({ directory, base });
        expect([base, assets.pathPrefix]).toEqual([base, ""]);
      }
    }),
  );

  it.effect("aliases the SPA shell back to the root", () =>
    Effect.gen(function* () {
      const directory = yield* site();
      const assets = yield* readAssets({
        directory,
        base: "/docs/",
        notFoundHandling: "single-page-application",
      });

      expect(assets.manifest["/index.html"]).toEqual(
        assets.manifest["/docs/index.html"],
      );
    }),
  );

  it.effect("only aliases the shell in single-page-application mode", () =>
    Effect.gen(function* () {
      const directory = yield* site();
      const assets = yield* readAssets({ directory, base: "/docs/" });

      expect(assets.manifest["/index.html"]).toBeUndefined();
    }),
  );

  // Their rules match the incoming request path, so they are authored with
  // the full served path and sent verbatim rather than prefixed.
  it.effect("sends the config files verbatim and never uploads them", () =>
    Effect.gen(function* () {
      const directory = yield* site();
      const assets = yield* readAssets({ directory, base: "/docs/" });

      expect(assets.config).toMatchObject({
        headers: "/docs/*\n  X: y\n",
        redirects: "/a /docs/b 301\n",
      });
      expect(Object.keys(assets.manifest)).not.toContain("/docs/_headers");
      expect(Object.keys(assets.manifest)).not.toContain("/docs/.assetsignore");
    }),
  );

  // The prefix has to reach the change-detection hash, or a base change
  // alone would be a no-op deploy that leaves the old manifest live.
  it.effect("changes the hash when the base changes", () =>
    Effect.gen(function* () {
      const directory = yield* site();
      const root = yield* readAssets({ directory });
      const docs = yield* readAssets({ directory, base: "/docs/" });

      expect(docs.hash).not.toEqual(root.hash);
    }),
  );
});
