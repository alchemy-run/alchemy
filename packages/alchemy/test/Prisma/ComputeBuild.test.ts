import {
  runBuildCommand,
  runComputeAutoBuild,
  runComputeStaticBuild,
} from "@/Prisma/ComputeBuild";
import { createComputeArchive } from "@/Prisma/ComputeArchive";
import { PlatformServices } from "@/Util/PlatformServices";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { gunzipSync } from "node:zlib";

const inspectBuildEnvironmentCommand = [
  JSON.stringify(process.execPath),
  "-e",
  JSON.stringify(
    "process.stdout.write(JSON.stringify({ serviceToken: process.env.PRISMA_SERVICE_TOKEN ?? null, apiToken: process.env.PRISMA_API_TOKEN ?? null, inherited: process.env.ALCHEMY_BUILD_INHERITED_SENTINEL ?? null }))",
  ),
].join(" ");

const restoreProcessEnv = (name: string, value: string | undefined) => {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
};

describe("Prisma Compute auto-build", () => {
  it.effect("builds a Bun app from package.json main", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-auto-bun-",
      });
      yield* fs.makeDirectory(path.join(root, "src"));
      yield* fs.writeFileString(
        path.join(root, "package.json"),
        JSON.stringify({ main: "src/server.ts" }),
      );
      yield* fs.writeFileString(
        path.join(root, "src", "server.ts"),
        "console.log('auto bun');",
      );

      const artifact = yield* runComputeAutoBuild({
        appPath: root,
        framework: "bun",
      });
      const entrypointText = yield* fs.readFileString(
        path.join(artifact.directory, artifact.entrypoint),
      );

      expect(artifact.entrypoint).toBe("server.js");
      expect(entrypointText).toContain("auto bun");

      yield* artifact.cleanup;
      expect(yield* fs.exists(artifact.directory)).toBe(false);
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("builds a NestJS app from local CLI output", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-auto-nest-",
      });
      const binDir = path.join(root, "node_modules", ".bin");
      const nestBin = path.join(binDir, "nest");
      yield* fs.makeDirectory(binDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(root, "package.json"),
        JSON.stringify({ dependencies: { "@nestjs/core": "0.0.0-test" } }),
      );
      yield* fs.writeFileString(nestBin, "#!/usr/bin/env sh\nexit 0\n");
      yield* fs.chmod(nestBin, 0o755);
      yield* fs.makeDirectory(path.join(root, "dist"), { recursive: true });
      yield* fs.writeFileString(
        path.join(root, "dist", "main.js"),
        "console.log('nest server');",
      );

      const artifact = yield* runComputeAutoBuild({
        appPath: root,
        framework: "nestjs",
      });

      expect(artifact.entrypoint).toBe("dist/main.js");
      expect(artifact.defaultPort).toBe(3000);
      expect(
        yield* fs.readFileString(path.join(artifact.directory, "dist/main.js")),
      ).toContain("nest server");

      yield* artifact.cleanup;
      expect(yield* fs.exists(artifact.directory)).toBe(false);
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("auto-detects NestJS before the Bun fallback", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-auto-nest-detect-",
      });
      const binDir = path.join(root, "node_modules", ".bin");
      const nestBin = path.join(binDir, "nest");
      yield* fs.makeDirectory(binDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(root, "package.json"),
        JSON.stringify({ dependencies: { "@nestjs/core": "0.0.0-test" } }),
      );
      yield* fs.writeFileString(nestBin, "#!/usr/bin/env sh\nexit 0\n");
      yield* fs.chmod(nestBin, 0o755);
      yield* fs.makeDirectory(path.join(root, "dist", "src"), {
        recursive: true,
      });
      yield* fs.writeFileString(
        path.join(root, "dist", "src", "main.js"),
        "console.log('auto nest');",
      );

      const artifact = yield* runComputeAutoBuild({ appPath: root });

      expect(artifact.entrypoint).toBe("dist/src/main.js");

      yield* artifact.cleanup;
      expect(yield* fs.exists(artifact.directory)).toBe(false);
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("forwards output limits to framework build commands", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-auto-build-limit-",
      });
      const binDir = path.join(root, "node_modules", ".bin");
      const nestBin = path.join(binDir, "nest");
      yield* fs.makeDirectory(binDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(root, "package.json"),
        JSON.stringify({ dependencies: { "@nestjs/core": "0.0.0-test" } }),
      );
      yield* fs.writeFileString(
        nestBin,
        "#!/usr/bin/env sh\nprintf '123456789'\n",
      );
      yield* fs.chmod(nestBin, 0o755);

      const error = yield* runComputeAutoBuild({
        appPath: root,
        framework: "nestjs",
        outputLimitBytes: 8,
      }).pipe(Effect.flip);

      expect((error as Error).message).toContain(
        "Build stdout exceeded the 8 byte output safety limit",
      );
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.live("forwards deadlines to framework build commands", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-auto-build-timeout-",
      });
      const binDir = path.join(root, "node_modules", ".bin");
      const nestBin = path.join(binDir, "nest");
      yield* fs.makeDirectory(binDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(root, "package.json"),
        JSON.stringify({ dependencies: { "@nestjs/core": "0.0.0-test" } }),
      );
      yield* fs.writeFileString(nestBin, "#!/usr/bin/env sh\nsleep 10\n");
      yield* fs.chmod(nestBin, 0o755);

      const error = yield* runComputeAutoBuild({
        appPath: root,
        framework: "nestjs",
        timeoutSeconds: 0.05,
      }).pipe(Effect.flip);

      expect((error as Error).message).toContain(
        "Build command timed out after 0.05 seconds",
      );
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect(
    "resolves NestJS config output and stages traced dependencies",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectory({
          prefix: "alchemy-prisma-auto-nest-trace-",
        });
        const binDir = path.join(root, "node_modules", ".bin");
        const nestBin = path.join(binDir, "nest");
        yield* fs.makeDirectory(binDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(root, "package.json"),
          JSON.stringify({ dependencies: { "@nestjs/core": "0.0.0-test" } }),
        );
        yield* fs.writeFileString(
          path.join(root, "nest-cli.json"),
          JSON.stringify({ sourceRoot: "app", entryFile: "bootstrap" }),
        );
        yield* fs.writeFileString(
          path.join(root, "tsconfig.json"),
          [
            "{",
            "  // Keep URLs with // intact while reading compiler options.",
            '  "compilerOptions": {',
            '    "outDir": "build",',
            '    "sourceMappingURL": "https://example.com//maps"',
            "  }",
            "}",
          ].join("\n"),
        );
        yield* fs.writeFileString(nestBin, "#!/usr/bin/env sh\nexit 0\n");
        yield* fs.chmod(nestBin, 0o755);

        const usedDep = path.join(root, "node_modules", "used-dep");
        const unusedDep = path.join(root, "node_modules", "unused-dep");
        yield* fs.makeDirectory(usedDep, { recursive: true });
        yield* fs.writeFileString(
          path.join(usedDep, "package.json"),
          JSON.stringify({ name: "used-dep", main: "index.js" }),
        );
        yield* fs.writeFileString(
          path.join(usedDep, "index.js"),
          "module.exports = 'used';",
        );
        yield* fs.makeDirectory(unusedDep, { recursive: true });
        yield* fs.writeFileString(
          path.join(unusedDep, "package.json"),
          JSON.stringify({ name: "unused-dep", main: "index.js" }),
        );
        yield* fs.writeFileString(
          path.join(unusedDep, "index.js"),
          "module.exports = 'unused';",
        );
        yield* fs.makeDirectory(path.join(root, "build", "app"), {
          recursive: true,
        });
        yield* fs.writeFileString(
          path.join(root, "build", "app", "bootstrap.js"),
          "const used = require('used-dep'); console.log(used);",
        );

        const artifact = yield* runComputeAutoBuild({
          appPath: root,
          framework: "nestjs",
        });

        expect(artifact.entrypoint).toBe("build/app/bootstrap.js");
        expect(
          yield* fs.exists(
            path.join(
              artifact.directory,
              "node_modules",
              "used-dep",
              "index.js",
            ),
          ),
        ).toBe(true);
        expect(
          yield* fs.exists(
            path.join(artifact.directory, "node_modules", "unused-dep"),
          ),
        ).toBe(false);

        yield* artifact.cleanup;
        expect(yield* fs.exists(artifact.directory)).toBe(false);
      }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect(
    "uses a project-local framework CLI and copies Next.js extras",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectory({
          prefix: "alchemy-prisma-auto-next-",
        });
        const binDir = path.join(root, "node_modules", ".bin");
        const nextBin = path.join(binDir, "next");
        yield* fs.makeDirectory(binDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(root, "package.json"),
          JSON.stringify({ dependencies: { next: "0.0.0-test" } }),
        );
        yield* fs.writeFileString(
          nextBin,
          [
            "#!/bin/sh",
            "mkdir -p .next/standalone .next/static public",
            "printf 'next server' > .next/standalone/server.js",
            "printf 'next static' > .next/static/app.js",
            "printf 'next public' > public/asset.txt",
            "",
          ].join("\n"),
        );
        yield* fs.chmod(nextBin, 0o755);

        const artifact = yield* runComputeAutoBuild({
          appPath: root,
          framework: "nextjs",
        });

        expect(artifact.entrypoint).toBe("server.js");
        expect(artifact.defaultPort).toBe(3000);
        expect(
          yield* fs.readFileString(path.join(artifact.directory, "server.js")),
        ).toBe("next server");
        expect(
          yield* fs.readFileString(
            path.join(artifact.directory, ".next", "static", "app.js"),
          ),
        ).toBe("next static");
        expect(
          yield* fs.readFileString(
            path.join(artifact.directory, "public", "asset.txt"),
          ),
        ).toBe("next public");

        yield* artifact.cleanup;
        expect(yield* fs.exists(artifact.directory)).toBe(false);
      }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("uses an installed workspace framework CLI", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-auto-workspace-cli-",
      });
      const appPath = path.join(root, "apps", "web");
      const binDir = path.join(root, "node_modules", ".bin");
      const nextBin = path.join(binDir, "next");
      yield* fs.makeDirectory(appPath, { recursive: true });
      yield* fs.makeDirectory(binDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(root, "package.json"),
        JSON.stringify({ workspaces: ["apps/*"] }),
      );
      yield* fs.writeFileString(
        path.join(appPath, "package.json"),
        JSON.stringify({ dependencies: { next: "0.0.0-test" } }),
      );
      yield* fs.writeFileString(
        nextBin,
        [
          "#!/bin/sh",
          "mkdir -p .next/standalone",
          "printf 'workspace next server' > .next/standalone/server.js",
          "",
        ].join("\n"),
      );
      yield* fs.chmod(nextBin, 0o755);

      const artifact = yield* runComputeAutoBuild({
        appPath,
        framework: "nextjs",
      });

      expect(
        yield* fs.readFileString(path.join(artifact.directory, "server.js")),
      ).toBe("workspace next server");
      yield* artifact.cleanup;
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("never downloads a missing framework CLI", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-auto-no-network-cli-",
      });
      const fakeBin = path.join(root, "fake-bin");
      const fallbackMarker = path.join(root, "network-fallback-ran");
      yield* fs.makeDirectory(fakeBin, { recursive: true });
      yield* fs.writeFileString(
        path.join(root, "package.json"),
        JSON.stringify({ dependencies: { next: "0.0.0-test" } }),
      );
      for (const executable of ["npx", "bunx"]) {
        const executablePath = path.join(fakeBin, executable);
        yield* fs.writeFileString(
          executablePath,
          `#!/bin/sh\nprintf invoked > ${JSON.stringify(fallbackMarker)}\nexit 127\n`,
        );
        yield* fs.chmod(executablePath, 0o755);
      }

      const error = yield* runComputeAutoBuild({
        appPath: root,
        framework: "nextjs",
        env: { PATH: fakeBin },
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "Could not find an installed Next.js CLI",
      );
      expect(yield* fs.exists(fallbackMarker)).toBe(false);
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("rejects framework symlinks that escape the output root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-auto-link-escape-",
      });
      const binDir = path.join(root, "node_modules", ".bin");
      const nextBin = path.join(binDir, "next");
      const standalone = path.join(root, ".next", "standalone");
      yield* fs.makeDirectory(binDir, { recursive: true });
      yield* fs.makeDirectory(standalone, { recursive: true });
      yield* fs.writeFileString(
        path.join(root, "package.json"),
        JSON.stringify({ dependencies: { next: "0.0.0-test" } }),
      );
      yield* fs.writeFileString(nextBin, "#!/bin/sh\nexit 0\n");
      yield* fs.chmod(nextBin, 0o755);
      yield* fs.writeFileString(
        path.join(standalone, "server.js"),
        "console.log('server');",
      );
      yield* fs.writeFileString(path.join(root, "outside.txt"), "secret");
      yield* fs.symlink(
        "../../outside.txt",
        path.join(standalone, "outside.txt"),
      );

      const error = yield* runComputeAutoBuild({
        appPath: root,
        framework: "nextjs",
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "Compute artifact path escapes its staging root",
      );
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect(
    "rejects a framework output directory outside the application",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectory({
          prefix: "alchemy-prisma-auto-output-root-escape-",
        });
        const outside = yield* fs.makeTempDirectory({
          prefix: "alchemy-prisma-auto-external-output-",
        });
        const binDir = path.join(root, "node_modules", ".bin");
        const nextBin = path.join(binDir, "next");
        yield* fs.makeDirectory(binDir, { recursive: true });
        yield* fs.makeDirectory(path.join(root, ".next"), { recursive: true });
        yield* fs.writeFileString(
          path.join(root, "package.json"),
          JSON.stringify({ dependencies: { next: "0.0.0-test" } }),
        );
        yield* fs.writeFileString(nextBin, "#!/bin/sh\nexit 0\n");
        yield* fs.chmod(nextBin, 0o755);
        yield* fs.writeFileString(
          path.join(outside, "server.js"),
          "console.log('server');",
        );
        yield* fs.symlink(outside, path.join(root, ".next", "standalone"));

        const error = yield* runComputeAutoBuild({
          appPath: root,
          framework: "nextjs",
        }).pipe(Effect.flip);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain(
          "Compute artifact path escapes its staging root",
        );
      }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect(
    "rejects an oversized framework output file before copying it",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectory({
          prefix: "alchemy-prisma-auto-oversized-file-",
        });
        const binDir = path.join(root, "node_modules", ".bin");
        const nextBin = path.join(binDir, "next");
        const standalone = path.join(root, ".next", "standalone");
        const server = path.join(standalone, "server.js");
        yield* fs.makeDirectory(binDir, { recursive: true });
        yield* fs.makeDirectory(standalone, { recursive: true });
        yield* fs.writeFileString(
          path.join(root, "package.json"),
          JSON.stringify({ dependencies: { next: "0.0.0-test" } }),
        );
        yield* fs.writeFileString(nextBin, "#!/bin/sh\nexit 0\n");
        yield* fs.chmod(nextBin, 0o755);
        yield* fs.writeFileString(server, "");
        yield* fs.truncate(server, 128 * 1024 * 1024 + 1);

        const error = yield* runComputeAutoBuild({
          appPath: root,
          framework: "nextjs",
        }).pipe(Effect.flip);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain(
          "134217728 byte per-file safety limit",
        );
      }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("detects nested Next.js standalone entrypoints in monorepos", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-auto-next-monorepo-",
      });
      const binDir = path.join(root, "node_modules", ".bin");
      const nextBin = path.join(binDir, "next");
      yield* fs.makeDirectory(binDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(root, "package.json"),
        JSON.stringify({ dependencies: { next: "0.0.0-test" } }),
      );
      yield* fs.writeFileString(
        nextBin,
        [
          "#!/bin/sh",
          "mkdir -p .next/standalone/examples/prisma-nextjs .next/standalone/node_modules/pkg .next/static public",
          "printf 'nested next server' > .next/standalone/examples/prisma-nextjs/server.js",
          "printf 'dependency server' > .next/standalone/node_modules/pkg/server.js",
          "printf 'next static' > .next/static/app.js",
          "printf 'next public' > public/asset.txt",
          "",
        ].join("\n"),
      );
      yield* fs.chmod(nextBin, 0o755);

      const artifact = yield* runComputeAutoBuild({
        appPath: root,
        framework: "nextjs",
      });

      expect(artifact.entrypoint).toBe("examples/prisma-nextjs/server.js");
      expect(
        yield* fs.readFileString(
          path.join(artifact.directory, artifact.entrypoint),
        ),
      ).toBe("nested next server");
      expect(
        yield* fs.readFileString(
          path.join(
            artifact.directory,
            "examples",
            "prisma-nextjs",
            ".next",
            "static",
            "app.js",
          ),
        ),
      ).toBe("next static");
      expect(
        yield* fs.readFileString(
          path.join(
            artifact.directory,
            "examples",
            "prisma-nextjs",
            "public",
            "asset.txt",
          ),
        ),
      ).toBe("next public");

      yield* artifact.cleanup;
      expect(yield* fs.exists(artifact.directory)).toBe(false);
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("rejects ambiguous Next.js standalone entrypoints", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-auto-next-ambiguous-",
      });
      const binDir = path.join(root, "node_modules", ".bin");
      const nextBin = path.join(binDir, "next");
      yield* fs.makeDirectory(binDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(root, "package.json"),
        JSON.stringify({ dependencies: { next: "0.0.0-test" } }),
      );
      yield* fs.writeFileString(
        nextBin,
        [
          "#!/bin/sh",
          "mkdir -p .next/standalone/apps/web .next/standalone/apps/admin",
          "printf 'web server' > .next/standalone/apps/web/server.js",
          "printf 'admin server' > .next/standalone/apps/admin/server.js",
          "",
        ].join("\n"),
      );
      yield* fs.chmod(nextBin, 0o755);

      const error = yield* runComputeAutoBuild({
        appPath: root,
        framework: "nextjs",
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("multiple server.js files");
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect(
    "materializes Bun package aliases for Next.js standalone output",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectory({
          prefix: "alchemy-prisma-auto-next-bun-aliases-",
        });
        const binDir = path.join(root, "node_modules", ".bin");
        const nextBin = path.join(binDir, "next");
        yield* fs.makeDirectory(binDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(root, "package.json"),
          JSON.stringify({ dependencies: { next: "0.0.0-test" } }),
        );
        yield* fs.writeFileString(
          nextBin,
          [
            "#!/bin/sh",
            "set -eu",
            "mkdir -p .next/standalone/examples/prisma-nextjs",
            "mkdir -p .next/standalone/node_modules/.bun/@swc+helpers@0.5.15/node_modules/@swc/helpers",
            "mkdir -p .next/standalone/node_modules/.bun/node_modules/@swc",
            "printf 'nested next server' > .next/standalone/examples/prisma-nextjs/server.js",
            'printf \'{"name":"@swc/helpers"}\' > .next/standalone/node_modules/.bun/@swc+helpers@0.5.15/node_modules/@swc/helpers/package.json',
            "ln -s ../../@swc+helpers@0.5.15/node_modules/@swc/helpers .next/standalone/node_modules/.bun/node_modules/@swc/helpers",
            "",
          ].join("\n"),
        );
        yield* fs.chmod(nextBin, 0o755);

        const artifact = yield* runComputeAutoBuild({
          appPath: root,
          framework: "nextjs",
        });

        expect(artifact.entrypoint).toBe("examples/prisma-nextjs/server.js");
        expect(
          yield* fs.readFileString(
            path.join(
              artifact.directory,
              "node_modules",
              "@swc",
              "helpers",
              "package.json",
            ),
          ),
        ).toBe('{"name":"@swc/helpers"}');

        yield* artifact.cleanup;
        expect(yield* fs.exists(artifact.directory)).toBe(false);
      }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("auto-detects a Vite static SPA", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-auto-vite-",
      });
      const binDir = path.join(root, "node_modules", ".bin");
      const viteBin = path.join(binDir, "vite");
      yield* fs.makeDirectory(binDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(root, "package.json"),
        JSON.stringify({ devDependencies: { vite: "0.0.0-test" } }),
      );
      yield* fs.writeFileString(
        viteBin,
        [
          "#!/bin/sh",
          "set -eu",
          "mkdir -p dist/assets",
          "printf '<h1>Vite SPA</h1>' > dist/index.html",
          "printf 'console.log(1)' > dist/assets/app.js",
          "",
        ].join("\n"),
      );
      yield* fs.chmod(viteBin, 0o755);

      const artifact = yield* runComputeAutoBuild({ appPath: root });

      expect(artifact.entrypoint).toBe("server.mjs");
      expect(artifact.defaultPort).toBe(8080);
      expect(artifact.archiveIgnorePrefix).toBe("public");
      expect(
        yield* fs.readFileString(
          path.join(artifact.directory, "public", "index.html"),
        ),
      ).toBe("<h1>Vite SPA</h1>");

      yield* withStaticSiteServer(artifact.directory, (origin) =>
        Effect.gen(function* () {
          const response = yield* request(`${origin}/dashboard`);
          expect(response.status).toBe(200);
          expect(yield* responseText(response)).toBe("<h1>Vite SPA</h1>");
        }),
      );

      yield* artifact.cleanup;
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("detects TanStack Start before the Vite fallback", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-auto-tanstack-start-",
      });
      const binDir = path.join(root, "node_modules", ".bin");
      const viteBin = path.join(binDir, "vite");
      yield* fs.makeDirectory(binDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(root, "package.json"),
        JSON.stringify({
          dependencies: { "@tanstack/react-start": "0.0.0-test" },
          devDependencies: { vite: "0.0.0-test" },
        }),
      );
      yield* fs.writeFileString(
        viteBin,
        [
          "#!/bin/sh",
          "set -eu",
          "mkdir -p .output/server",
          "printf 'console.log(\"start\")' > .output/server/index.mjs",
          "",
        ].join("\n"),
      );
      yield* fs.chmod(viteBin, 0o755);

      const artifact = yield* runComputeAutoBuild({ appPath: root });

      expect(artifact.entrypoint).toBe("server/index.mjs");
      expect(artifact.defaultPort).toBe(3000);
      expect(
        yield* fs.readFileString(
          path.join(artifact.directory, "server", "index.mjs"),
        ),
      ).toContain('console.log("start")');

      yield* artifact.cleanup;
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("bounds retained build stdout", () =>
    Effect.gen(function* () {
      const error = yield* runBuildCommand({
        command: "printf '123456789'",
        outputLimitBytes: 8,
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "Build stdout exceeded the 8 byte output safety limit",
      );
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("bounds retained build stderr", () =>
    Effect.gen(function* () {
      const error = yield* runBuildCommand({
        command: "printf '123456789' >&2",
        outputLimitBytes: 8,
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "Build stderr exceeded the 8 byte output safety limit",
      );
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("does not expose failed build output in errors", () =>
    Effect.gen(function* () {
      const error = yield* runBuildCommand({
        command: "printf 'BUILD_SECRET_SENTINEL' >&2; exit 17",
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("exit code 17");
      expect((error as Error).message).toContain("stderr: 21 bytes");
      expect((error as Error).message).not.toContain("BUILD_SECRET_SENTINEL");
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("withholds ambient Prisma credentials from build commands", () =>
    Effect.gen(function* () {
      const previousServiceToken = process.env.PRISMA_SERVICE_TOKEN;
      const previousApiToken = process.env.PRISMA_API_TOKEN;
      const previousInherited = process.env.ALCHEMY_BUILD_INHERITED_SENTINEL;
      process.env.PRISMA_SERVICE_TOKEN = "ambient-service-token";
      process.env.PRISMA_API_TOKEN = "ambient-api-token";
      process.env.ALCHEMY_BUILD_INHERITED_SENTINEL = "inherited-value";

      try {
        const result = yield* runBuildCommand({
          command: inspectBuildEnvironmentCommand,
        });

        expect(JSON.parse(result.stdout)).toEqual({
          serviceToken: null,
          apiToken: null,
          inherited: "inherited-value",
        });
      } finally {
        restoreProcessEnv("PRISMA_SERVICE_TOKEN", previousServiceToken);
        restoreProcessEnv("PRISMA_API_TOKEN", previousApiToken);
        restoreProcessEnv(
          "ALCHEMY_BUILD_INHERITED_SENTINEL",
          previousInherited,
        );
      }
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("allows explicitly configured Prisma build credentials", () =>
    Effect.gen(function* () {
      const result = yield* runBuildCommand({
        command: inspectBuildEnvironmentCommand,
        env: {
          PRISMA_SERVICE_TOKEN: "explicit-service-token",
          PRISMA_API_TOKEN: "explicit-api-token",
        },
      });

      expect(JSON.parse(result.stdout)).toEqual({
        serviceToken: "explicit-service-token",
        apiToken: "explicit-api-token",
        inherited: null,
      });
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.live("interrupts a silent build at its configured deadline", () =>
    Effect.gen(function* () {
      const error = yield* runBuildCommand({
        command: "sleep 10",
        timeoutSeconds: 0.05,
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "Build command timed out after 0.05 seconds",
      );
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.live("kills descendant processes when a build times out", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-build-process-group-",
      });
      const marker = path.join(root, "descendant-survived");

      yield* runBuildCommand({
        command: `(sleep 0.4; printf survived > ${JSON.stringify(marker)}) & sleep 10`,
        timeoutSeconds: 0.05,
      }).pipe(Effect.flip);
      yield* Effect.sleep("700 millis");

      expect(yield* fs.exists(marker)).toBe(false);
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.live("reaps descendants left by a successful build shell", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-build-success-process-group-",
      });
      const marker = path.join(root, "descendant-survived");

      yield* runBuildCommand({
        command: `(sleep 0.4; printf survived > ${JSON.stringify(marker)}) >/dev/null 2>&1 &`,
      });
      yield* Effect.sleep("700 millis");

      expect(yield* fs.exists(marker)).toBe(false);
    }).pipe(Effect.provide(PlatformServices)),
  );
});

describe("Prisma Compute static-site build", () => {
  it.effect("packages and serves static files with SPA fallback", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-static-site-",
      });
      yield* fs.writeFileString(
        path.join(root, "build.mjs"),
        [
          'import { mkdir } from "node:fs/promises";',
          'await mkdir("dist/assets", { recursive: true });',
          'await mkdir("dist/docs", { recursive: true });',
          'await Bun.write("dist/index.html", "<h1>app shell</h1>");',
          'await Bun.write("dist/assets/app.js", "console.log(\'asset\')");',
          'await Bun.write("dist/docs/index.html", "<h1>docs</h1>");',
          'await Bun.write("dist/docs #1.html", "encoded asset");',
          "",
        ].join("\n"),
      );

      const artifact = yield* runComputeStaticBuild({
        appPath: root,
        command: `${JSON.stringify(process.execPath)} build.mjs`,
        outdir: "dist",
        spa: true,
      });

      expect(artifact.entrypoint).toBe("server.mjs");
      expect(artifact.defaultPort).toBe(8080);
      expect(
        yield* fs.readFileString(
          path.join(artifact.directory, "public", "index.html"),
        ),
      ).toBe("<h1>app shell</h1>");
      expect(yield* fs.exists(path.join(root, "server.mjs"))).toBe(false);

      yield* withStaticSiteServer(artifact.directory, (origin) =>
        Effect.gen(function* () {
          const rootResponse = yield* request(`${origin}/`);
          expect(rootResponse.status).toBe(200);
          expect(yield* responseText(rootResponse)).toBe("<h1>app shell</h1>");

          const assetResponse = yield* request(`${origin}/assets/app.js`);
          expect(assetResponse.status).toBe(200);
          expect(assetResponse.headers.get("content-type")).toContain(
            "javascript",
          );
          expect(yield* responseText(assetResponse)).toBe(
            "console.log('asset')",
          );

          const directoryResponse = yield* request(`${origin}/docs/`);
          expect(directoryResponse.status).toBe(200);
          expect(yield* responseText(directoryResponse)).toBe("<h1>docs</h1>");

          const encodedResponse = yield* request(`${origin}/docs%20%231.html`);
          expect(encodedResponse.status).toBe(200);
          expect(yield* responseText(encodedResponse)).toBe("encoded asset");

          const fallbackResponse = yield* request(
            `${origin}/dashboard/settings`,
          );
          expect(fallbackResponse.status).toBe(200);
          expect(yield* responseText(fallbackResponse)).toBe(
            "<h1>app shell</h1>",
          );

          const headResponse = yield* request(`${origin}/assets/app.js`, {
            method: "HEAD",
          });
          expect(headResponse.status).toBe(200);
          expect(headResponse.headers.get("content-length")).toBe("20");
          expect(yield* responseText(headResponse)).toBe("");

          const postResponse = yield* request(`${origin}/`, {
            method: "POST",
          });
          expect(postResponse.status).toBe(405);
          expect(postResponse.headers.get("allow")).toBe("GET, HEAD");

          const traversalResponse = yield* request(`${origin}/..%2Fsecret`);
          expect(traversalResponse.status).toBe(400);
        }),
      );

      yield* artifact.cleanup;
      expect(yield* fs.exists(artifact.directory)).toBe(false);
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("serves a custom root page without enabling SPA fallback", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-static-site-no-spa-",
      });
      yield* fs.makeDirectory(path.join(root, "dist"));
      yield* fs.writeFileString(
        path.join(root, "dist", "home.html"),
        "static home",
      );

      const artifact = yield* runComputeStaticBuild({
        appPath: root,
        command: "true",
        outdir: "dist",
        indexPage: "home.html",
      });

      yield* withStaticSiteServer(artifact.directory, (origin) =>
        Effect.gen(function* () {
          const rootResponse = yield* request(`${origin}/`);
          expect(rootResponse.status).toBe(200);
          expect(yield* responseText(rootResponse)).toBe("static home");

          const missingResponse = yield* request(`${origin}/missing`);
          expect(missingResponse.status).toBe(404);
          expect(yield* responseText(missingResponse)).toBe("Not Found");
        }),
      );

      yield* artifact.cleanup;
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("scopes archive ignores to the static output", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-static-site-ignore-",
      });
      yield* fs.makeDirectory(path.join(root, "dist", "assets"), {
        recursive: true,
      });
      yield* fs.writeFileString(
        path.join(root, "dist", "index.html"),
        "static home",
      );
      yield* fs.writeFileString(
        path.join(root, "dist", "assets", "app.mjs"),
        "app",
      );
      yield* fs.writeFileString(
        path.join(root, "dist", "assets", "app.js.map"),
        "source map",
      );

      const artifact = yield* runComputeStaticBuild({
        appPath: root,
        command: "true",
        outdir: "dist",
      });
      const archive = yield* createComputeArchive({
        directory: artifact.directory,
        entrypoint: artifact.entrypoint,
        ignore: ["assets/*.map", "*.mjs"],
        ignorePrefix: artifact.archiveIgnorePrefix,
      }).pipe(Effect.ensuring(artifact.cleanup));
      const tarText = new TextDecoder().decode(
        yield* Effect.sync(() => gunzipSync(archive)),
      );

      expect(tarText).toContain("bundle/server.mjs");
      expect(tarText).toContain("bundle/public/index.html");
      expect(tarText).toContain("bundle/public/assets/app.mjs");
      expect(tarText).not.toContain("bundle/public/assets/app.js.map");
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("rejects unsafe output and index paths", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-static-site-paths-",
      });

      const outdirError = yield* runComputeStaticBuild({
        appPath: root,
        command: "true",
        outdir: "../dist",
      }).pipe(Effect.flip);
      expect((outdirError as Error).message).toContain(
        "outdir must be a relative path",
      );

      const indexError = yield* runComputeStaticBuild({
        appPath: root,
        command: "true",
        outdir: "dist",
        indexPage: "../index.html",
      }).pipe(Effect.flip);
      expect((indexError as Error).message).toContain(
        "indexPage must be a relative file path",
      );
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("fails when the build output or index page is missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-static-site-missing-",
      });

      const outputError = yield* runComputeStaticBuild({
        appPath: root,
        command: "true",
        outdir: "dist",
      }).pipe(Effect.flip);
      expect((outputError as Error).message).toContain(
        "did not produce an output directory",
      );

      yield* fs.makeDirectory(path.join(root, "dist"));
      const indexError = yield* runComputeStaticBuild({
        appPath: root,
        command: "true",
        outdir: "dist",
      }).pipe(Effect.flip);
      expect((indexError as Error).message).toContain(
        "did not produce index.html",
      );
    }).pipe(Effect.provide(PlatformServices)),
  );
});

const withStaticSiteServer = <A, E, R>(
  directory: string,
  use: (origin: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const listener = Bun.listen({
        hostname: "127.0.0.1",
        port: 0,
        socket: { data() {} },
      });
      const port = listener.port;
      listener.stop(true);
      return {
        origin: `http://127.0.0.1:${port}`,
        process: Bun.spawn([process.execPath, "server.mjs"], {
          cwd: directory,
          env: { ...process.env, PORT: String(port) },
          stdout: "pipe",
          stderr: "pipe",
        }),
      };
    }),
    ({ origin }) => use(origin),
    ({ process }) =>
      Effect.tryPromise(async () => {
        process.kill();
        await process.exited;
      }).pipe(Effect.ignore),
  );

const request = (url: string, init?: RequestInit) =>
  Effect.tryPromise({
    try: async () => {
      let error: unknown;
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          return await fetch(url, init);
        } catch (cause) {
          error = cause;
          await Bun.sleep(20);
        }
      }
      throw error;
    },
    catch: (cause) => cause,
  });

const responseText = (response: Response) =>
  Effect.tryPromise({
    try: () => response.text(),
    catch: (cause) => cause,
  });
