import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

layer(NodeServices.layer)("provider WebSocket RPC client exports", (it) => {
  for (const compiled of [false, true]) {
    it.effect.skipIf(compiled && !process.env.ALCHEMY_TEST_RPC_CLIENT_LIB)(
      `bundle all three ${compiled ? "published" : "source"} browser entry points through one shared client`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* path.fromFileUrl(
            new URL("../../", import.meta.url),
          );
          let cwd = root;
          const json = yield* fs.readFileString(
            path.join(root, "package.json"),
          );
          const manifest = yield* Effect.try(
            () => JSON.parse(json) as typeof import("../../package.json"),
          );
          for (const provider of ["Cloudflare", "Celld", "Rivet"] as const) {
            const subpath = `./${provider}/RpcWebSocketClient` as const;
            const module = `${provider}/${provider === "Cloudflare" ? "Workers/" : ""}RpcWebSocketClient`;
            expect(manifest.exports[subpath]).toBe(`./src/${module}.ts`);
            expect(manifest.publishConfig.exports[subpath]).toEqual({
              types: `./lib/${module}.d.ts`,
              bun: `./src/${module}.ts`,
              default: `./lib/${module}.js`,
            });
          }
          if (compiled) {
            cwd = yield* fs.makeTempDirectoryScoped({
              prefix: "alchemy-provider-rpc-clients-",
            });
            const packageRoot = path.join(cwd, "node_modules/alchemy");
            yield* fs.makeDirectory(packageRoot, { recursive: true });
            yield* fs.writeFileString(
              path.join(packageRoot, "package.json"),
              JSON.stringify({
                name: manifest.name,
                type: manifest.type,
                sideEffects: manifest.sideEffects,
                exports: manifest.publishConfig.exports,
              }),
            );
            for (const directory of ["src", "lib"]) {
              yield* fs.symlink(
                path.join(root, directory),
                path.join(packageRoot, directory),
              );
            }
            yield* fs.symlink(
              path.join(root, "node_modules/effect"),
              path.join(cwd, "node_modules/effect"),
            );
          }
          const entrypoint = ["Cloudflare", "Celld", "Rivet"]
            .map(
              (provider) =>
                `export { layer as ${provider} } from "alchemy/${provider}/RpcWebSocketClient";`,
            )
            .join("\n");
          const entryPath = compiled
            ? path.join(cwd, "entry.ts")
            : "rpc-client-entry";
          if (compiled) yield* fs.writeFileString(entryPath, entrypoint);
          const { rolldown } = yield* Effect.promise(() => import("rolldown"));
          const modules = new Set<string>();
          const result = yield* Effect.acquireUseRelease(
            Effect.promise(() =>
              rolldown({
                cwd,
                input: entryPath,
                platform: "browser",
                plugins: [
                  {
                    name: "rpc-client-entry",
                    resolveId(id) {
                      if (id === "rpc-client-entry")
                        return "\0rpc-client-entry";
                    },
                    load(id) {
                      if (id === "\0rpc-client-entry") return entrypoint;
                    },
                    moduleParsed(info) {
                      modules.add(info.id.replaceAll("\\", "/"));
                    },
                  },
                ],
              }),
            ),
            (bundle) =>
              Effect.promise(() => bundle.generate({ format: "esm" })),
            (bundle) => Effect.promise(() => bundle.close()),
          );
          const entry = result.output.find(
            (output) => output.type === "chunk" && output.isEntry,
          );
          expect(entry?.type).toBe("chunk");
          if (entry?.type !== "chunk") return;
          expect(entry.exports).toEqual(["Celld", "Cloudflare", "Rivet"]);
          expect(
            [...modules].filter((id) =>
              id.endsWith(
                compiled
                  ? "/lib/Workers/RpcWebSocketClient.js"
                  : "/src/Workers/RpcWebSocketClient.ts",
              ),
            ),
          ).toHaveLength(1);
          expect(
            [...modules].filter((id) =>
              /\/(?:src\/(?:Auth|Bundle|Local|Resource|Stack)|node_modules\/(?:rivetkit|workerd|rolldown|esbuild))(?:\/|\.)/.test(
                id,
              ),
            ),
          ).toEqual([]);
          expect(entry.imports).toEqual([]);
          expect(entry.dynamicImports).toEqual([]);
        }),
    );
  }
});
