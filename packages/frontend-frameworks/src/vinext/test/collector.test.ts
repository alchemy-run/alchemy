import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { describe, expect, it } from "vitest";
import { WORKER_ENTRY_PREFIX } from "../../core/Collector.ts";
import { makeOutputCollector, syncVinextServerModules } from "../source.ts";

const WORKER_CODE = "export default { fetch() { return new Response('ok'); } };";

describe("vinext build-output collector", () => {
  it("pins the Worker facade and picks up modules Vinext writes after writeBundle", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "vinext-collector-" });
          const collector = makeOutputCollector("rsc");

          // Vinext's own rsc entry precedes the wrapped Worker main.
          yield* Effect.promise(() =>
            collector.plugin.writeBundle.call(
              {
                environment: {
                  name: "rsc",
                  config: { base: "/", root, build: { outDir: "dist/server" } },
                },
                getModuleIds: () => [],
              },
              {},
              {
                "app.js": {
                  type: "chunk",
                  isEntry: true,
                  fileName: "app.js",
                  facadeModuleId: "\0virtual:vinext-rsc-entry",
                  code: "export const metadata = {};",
                  imports: [],
                },
                "worker.js": {
                  type: "chunk",
                  isEntry: true,
                  fileName: "worker.js",
                  facadeModuleId: `${WORKER_ENTRY_PREFIX}worker/index.ts`,
                  code: WORKER_CODE,
                  imports: [],
                },
              },
            ),
          );
          const snapshot = collector.snapshot();
          expect(snapshot.serverEntry).toBe("dist/server/worker.js");

          // Vinext rewrites the chunk and writes sidecars outside any bundle.
          const outDir = path.join(root, "dist/server");
          yield* fs.makeDirectory(outDir, { recursive: true });
          yield* fs.writeFileString(path.join(outDir, "app.js"), "export const metadata = {};");
          yield* fs.writeFileString(
            path.join(outDir, "worker.js"),
            `import "./__vinext_action_owner_manifest.js";\nimport assets from "./vinext-client-assets.js";\n${WORKER_CODE}`,
          );
          yield* fs.writeFileString(
            path.join(outDir, "__vinext_action_owner_manifest.js"),
            "export const owners = {};",
          );
          yield* fs.writeFileString(
            path.join(outDir, "vinext-client-assets.js"),
            "export default { lazyChunks: [] };",
          );

          yield* syncVinextServerModules(root, snapshot.serverChunks);

          expect(String(snapshot.serverChunks.get("dist/server/worker.js")?.content)).toContain(
            "__vinext_action_owner_manifest",
          );
          expect(snapshot.serverChunks.has("dist/server/__vinext_action_owner_manifest.js")).toBe(
            true,
          );
          expect(snapshot.serverChunks.has("dist/server/vinext-client-assets.js")).toBe(true);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    ));
});
