import { runComputeAutoBuild } from "@/Prisma/ComputeBuild";
import { PlatformServices } from "@/Util/PlatformServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

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
});
