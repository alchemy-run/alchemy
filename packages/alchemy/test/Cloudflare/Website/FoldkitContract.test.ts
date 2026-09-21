import { pathToFileURL } from "node:url";
import {
  foldkitAssetsFromManifest,
  makeFoldkitSource,
  readFoldkitBuildManifest,
} from "@alchemy.run/frontend-frameworks/foldkit/source";
import {
  Artifacts,
  createArtifactStore,
  makeScopedArtifacts,
} from "@/Artifacts.ts";
import { makeSourceContext, sourceHost } from "@/Cloudflare/Workers/Source.ts";
import { Worker } from "@/Cloudflare/Workers/Worker.ts";
import {
  makeViteSource,
  viteBuild,
} from "@/Cloudflare/Workers/Sources/Vite.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { cloneFixture } from "../Utils/Fixture.ts";

const fixture = (name: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return yield* cloneFixture(path.join(import.meta.dirname, name), {
      prefix: "foldkit-contract-",
      tempRoot: path.resolve(import.meta.dirname, "../../../.tmp"),
      entries: ["index.html", "package.json", "vite.config.ts", "src"],
    });
  });
const build = (rootDir: string, main?: string) =>
  viteBuild(
    rootDir,
    {},
    {
      main,
      compatibilityDate: "2024-09-23",
      compatibilityFlags: ["nodejs_compat"],
    },
    "FoldkitContract",
  );

layer(NodeServices.layer)("Foldkit published build contract", (it) => {
  it.effect(
    "emits a deployable handler and manifest, keeping only rendered HTML in assets",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fixture("foldkit-ssr-fixture");
        const output = yield* build(root);
        const manifest = yield* readFoldkitBuildManifest(
          output.serverDirectory,
        );
        expect(manifest).toEqual({
          schemaVersion: 1,
          client: "dist/client",
          server: "dist/server",
          serverEntry: "fetch.js",
          prerendered: ["/about"],
        });
        expect(output.clientDirectory).toBe(path.join(root, manifest!.client));
        expect(output.serverDirectory).toBe(path.join(root, manifest!.server));
        expect(
          yield* fs.exists(path.join(output.clientDirectory!, "index.html")),
        ).toBe(false);
        expect(
          yield* fs.readFileString(
            path.join(output.clientDirectory!, "about/index.html"),
          ),
        ).toContain(">0<");
        const bundle = yield* output.serverBundle;
        expect(bundle?.files[0]?.path).toBe("dist/server/fetch.js");
        const probe = yield* ChildProcess.make(
          process.execPath,
          [
            path.join(import.meta.dirname, "fixtures/foldkit-handler-probe.ts"),
            pathToFileURL(
              path.join(output.serverDirectory!, manifest!.serverEntry),
            ).href,
          ],
          { stdout: "pipe", stderr: "pipe" },
        );
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            probe.stdout.pipe(Stream.decodeText, Stream.mkString),
            probe.stderr.pipe(Stream.decodeText, Stream.mkString),
            probe.exitCode,
          ],
          { concurrency: 3 },
        );
        expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
        const response = JSON.parse(stdout) as {
          status: number;
          html: string;
          missingStatus: number;
        };
        expect(response.status).toBe(200);
        expect(response.html).toContain(">7<");
        expect(response.html).not.toContain('rel="canonical"');
        expect(response.missingStatus).toBe(404);

        expect(
          foldkitAssetsFromManifest(
            yield* readFoldkitBuildManifest(output.serverDirectory),
          ),
        ).toBeUndefined();
      }).pipe(Effect.scoped),
    { timeout: 120_000 },
  );

  for (const entryName of ["worker", "fetch"]) {
    it.effect(
      `rejects ${entryName}.ts as main alongside the generated fetch entry`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fixture("foldkit-ssr-fixture");
          const main = path.join(root, `src/${entryName}.ts`);
          yield* fs.writeFileString(
            main,
            'export default { fetch() { return new Response("wrong entry") } };',
          );
          // Turn off prerendering so even a custom entry named "fetch" can
          // finish building: the source must reject it from the manifest.
          const config = path.join(root, "vite.config.ts");
          yield* fs.writeFileString(
            config,
            (yield* fs.readFileString(config)).replace(
              "prerender: true",
              "prerender: false",
            ),
          );
          const result = yield* Effect.result(
            makeFoldkitSource({ rootDir: root, main }, sourceHost)
              .build(
                makeSourceContext({
                  id: "Conflict",
                  fqn: "Conflict",
                  workerName: "conflict",
                  props: {},
                  compatibility: {
                    date: "2024-09-23",
                    flags: ["nodejs_compat"],
                  },
                  stack: { name: "contract", stage: "test" },
                }),
              )
              .pipe(
                Effect.provideService(
                  Artifacts,
                  makeScopedArtifacts(createArtifactStore(), "conflict"),
                ),
              ),
          );
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure") {
            expect(String(result.failure)).toContain(
              entryName === "fetch"
                ? "cannot be combined with main"
                : 'no entry chunk named "fetch"',
            );
          }
        }).pipe(Effect.scoped),
      { timeout: 120_000 },
    );
  }

  it.effect(
    "supports pure SSR and custom output directories",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fixture("foldkit-ssr-fixture");
        const config = path.join(root, "vite.config.ts");
        yield* fs.writeFileString(
          config,
          (yield* fs.readFileString(config)).replace(
            "prerender: true",
            'prerender: false, clientOutDir: "build/browser", serverOutDir: "build/edge"',
          ),
        );
        const output = yield* build(root);
        const manifest = yield* readFoldkitBuildManifest(
          output.serverDirectory,
        );
        expect(manifest).toEqual({
          schemaVersion: 1,
          client: "build/browser",
          server: "build/edge",
          serverEntry: "fetch.js",
          prerendered: [],
        });
        expect(output.serverDirectory).toBe(path.join(root, "build/edge"));
        expect(output.clientDirectory).toBe(path.join(root, "build/browser"));
        expect(
          yield* fs.exists(path.join(output.clientDirectory!, "index.html")),
        ).toBe(false);
      }).pipe(Effect.scoped),
    { timeout: 120_000 },
  );

  for (const framework of [undefined, "foldkit"] as const) {
    it.effect(
      `preserves custom main, asset overrides and public env for ${framework ?? "plain Vite"}`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const rootDir = yield* fixture("foldkit-worker-fixture");
          const configPath = path.join(rootDir, "vite.config.ts");
          yield* fs.writeFileString(
            configPath,
            (yield* fs.readFileString(configPath)).replace(
              "defineConfig({",
              'defineConfig({ base: "/app/",',
            ),
          );
          yield* fs.writeFileString(
            path.join(rootDir, "src/worker.ts"),
            "export default { fetch() { return new Response(import.meta.env.VITE_SELF_URL) } };",
          );
          const vite = {
            rootDir,
            main: "src/worker.ts",
            memo: {
              include: [
                "src/**",
                "index.html",
                "vite.config.ts",
                "package.json",
              ],
            },
          };
          const source = framework
            ? makeFoldkitSource(vite, sourceHost)
            : makeViteSource(vite);
          const output = yield* source
            .build(
              makeSourceContext({
                id: "Contract",
                fqn: "Contract",
                workerName: "contract",
                props: {
                  vite,
                  env: { VITE_SELF_URL: Worker.URL },
                  assets: {
                    directory: "ignored-by-vite",
                    notFoundHandling: "404-page",
                    runWorkerFirst: ["/api/*"],
                  },
                },
                compatibility: { date: "2024-09-23", flags: ["nodejs_compat"] },
                stack: { name: "contract", stage: "test" },
                selfUrl: "https://contract.example.test",
              }),
            )
            .pipe(
              Effect.provideService(
                Artifacts,
                makeScopedArtifacts(createArtifactStore(), "contract"),
              ),
            );
          expect(output.assets?.config?.notFoundHandling).toBe("404-page");
          expect(output.assets?.config?.runWorkerFirst).toEqual(["/api/*"]);
          expect(output.assets?.pathPrefix).toBe("/app");
          expect(Object.keys(output.assets!.manifest)).toContain(
            "/app/index.html",
          );
          expect(output.bundle?.files[0]?.path).toContain("worker.js");
          expect(
            output.bundle?.files.map((file) => String(file.content)).join("\n"),
          ).toContain("https://contract.example.test");
        }).pipe(Effect.scoped),
      { timeout: 120_000 },
    );
  }

  for (const mode of ["ssr", "custom"] as const) {
    it.effect(
      `serves ${mode} through the source module in an isolated dev child`,
      () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const root = yield* fixture(
            mode === "ssr" ? "foldkit-ssr-fixture" : "foldkit-worker-fixture",
          );
          const probe = yield* ChildProcess.make(
            process.execPath,
            [
              path.join(import.meta.dirname, "fixtures/foldkit-dev-probe.ts"),
              mode,
            ],
            { cwd: root, stdout: "pipe", stderr: "pipe" },
          );
          const [stdout, stderr, exitCode] = yield* Effect.all(
            [
              probe.stdout.pipe(Stream.decodeText, Stream.mkString),
              probe.stderr.pipe(Stream.decodeText, Stream.mkString),
              probe.exitCode,
            ],
            { concurrency: 3 },
          );
          expect({
            exitCode,
            failure: exitCode === 0 ? "" : stderr + stdout,
          }).toEqual({ exitCode: 0, failure: "" });
          expect(stdout).toContain("foldkit-dev-ok");
        }).pipe(Effect.scoped),
      { timeout: 120_000 },
    );
  }

  it.effect(
    "keeps a client-only build assets-only with SPA routing",
    () =>
      Effect.gen(function* () {
        const root = yield* fixture("foldkit-fixture");
        const output = yield* build(root);
        expect(yield* output.serverBundle).toBeUndefined();
        expect(output.serverDirectory).toBeUndefined();
        expect(
          foldkitAssetsFromManifest(
            yield* readFoldkitBuildManifest(output.serverDirectory),
          ),
        ).toEqual({ notFoundHandling: "single-page-application" });
      }).pipe(Effect.scoped),
    { timeout: 120_000 },
  );
});
