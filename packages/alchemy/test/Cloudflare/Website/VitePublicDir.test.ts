import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { runViteBuildChild } from "@/Cloudflare/Workers/ViteChild.ts";
import { PlatformServices } from "@/Util/PlatformServices.ts";

const writeApp = (root: string, indexHtml: string | undefined) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.join(root, "src"), { recursive: true });
    yield* fs.makeDirectory(path.join(root, "public"), { recursive: true });
    yield* fs.writeFileString(
      path.join(root, "package.json"),
      JSON.stringify({ name: "vite-public-dir", private: true, type: "module" }),
    );
    yield* fs.writeFileString(path.join(root, "vite.config.ts"), "export default {};\n");
    yield* fs.writeFileString(
      path.join(root, "src/index.ts"),
      `export default { fetch: () => new Response("ok") };\n`,
    );
    yield* fs.writeFileString(path.join(root, "public/robots.txt"), "User-agent: *\nAllow: /\n");
    if (indexHtml !== undefined) {
      yield* fs.writeFileString(path.join(root, "index.html"), indexHtml);
    }
  });

const build = (root: string) =>
  runViteBuildChild(
    {
      rootDir: root,
      env: {},
      main: "./src/index.ts",
      compatibilityDate: "2026-09-01",
      compatibilityFlags: ["nodejs_compat"],
      viteEnvironments: undefined,
    },
    () => Effect.void,
  );

describe("Vite public directory", { timeout: 90_000 }, () => {
  it.live("a server-only Worker uploads a non-empty public directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({
        directory: path.join(import.meta.dirname, "../../.."),
        prefix: "alchemy-vite-public-",
      });
      yield* writeApp(root, undefined);

      const result = yield* build(root);

      expect(result.clientDirectory).toBe(path.join(root, "public"));
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.live("an index.html build keeps the client output ahead of public/", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({
        directory: path.join(import.meta.dirname, "../../.."),
        prefix: "alchemy-vite-html-",
      });
      yield* writeApp(root, "<html><body>shell</body></html>\n");

      const result = yield* build(root);

      expect(result.clientDirectory).toBe(path.join(root, "dist/client"));
      expect(yield* fs.exists(path.join(result.clientDirectory!, "index.html"))).toBe(true);
      expect(yield* fs.exists(path.join(result.clientDirectory!, "robots.txt"))).toBe(true);
    }).pipe(Effect.provide(PlatformServices)),
  );
});
