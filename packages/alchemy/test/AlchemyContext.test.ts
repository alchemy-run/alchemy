import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@alchemy.run/test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ChildProcess from "effect/process/ChildProcess";
import path from "pathe";
import { AlchemyContext, AlchemyContextLive, dotAlchemyDirectory } from "@/AlchemyContext.ts";
import { PlatformServices } from "@/Util/PlatformServices.ts";
import { nodePath, nodeSupportsDevMode } from "./nodeProbe.ts";

const cli = fileURLToPath(new URL("../bin/cli.js", import.meta.url));

const makeContextWithEnv = (env: Record<string, string>) =>
  Effect.gen(function* () {
    const madeDirectories: string[] = [];
    const context = yield* AlchemyContext.pipe(
      Effect.provide(
        AlchemyContextLive.pipe(
          Layer.provide(
            Layer.mergeAll(
              ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
              FileSystem.layerNoop({
                makeDirectory: (directory) =>
                  Effect.sync(() => {
                    madeDirectories.push(directory);
                  }),
              }),
            ),
          ),
        ),
      ),
    );
    return { context, madeDirectories };
  });

describe("AlchemyContext runtime directory", { tags: ["unit", "local"] }, () => {
  it.effect("uses .alchemy when ALCHEMY_DIR is absent", () =>
    Effect.gen(function* () {
      const { context, madeDirectories } = yield* makeContextWithEnv({});

      expect(context.dotAlchemy).toBe(path.resolve(".alchemy"));
      expect(madeDirectories).toEqual([path.resolve(".alchemy")]);
    }),
  );

  it.effect("treats an empty ALCHEMY_DIR as an unset override", () =>
    Effect.gen(function* () {
      const { context, madeDirectories } = yield* makeContextWithEnv({
        ALCHEMY_DIR: "",
      });

      expect(context.dotAlchemy).toBe(path.resolve(".alchemy"));
      expect(madeDirectories).toEqual([path.resolve(".alchemy")]);
    }),
  );

  it.effect("uses an absolute ALCHEMY_DIR for the runtime directory", () =>
    Effect.gen(function* () {
      const custom = path.resolve("custom-alchemy-root");
      const { context, madeDirectories } = yield* makeContextWithEnv({
        ALCHEMY_DIR: custom,
      });

      expect(context.dotAlchemy).toBe(custom);
      expect(madeDirectories).toEqual([custom]);
    }),
  );

  it.effect("resolves a relative ALCHEMY_DIR from the working directory", () =>
    Effect.gen(function* () {
      const relative = "custom/runtime";
      const { context, madeDirectories } = yield* makeContextWithEnv({
        ALCHEMY_DIR: relative,
      });

      expect(context.dotAlchemy).toBe(path.resolve(relative));
      expect(madeDirectories).toEqual([path.resolve(relative)]);
    }),
  );

  it.effect("prefers an injected AlchemyContext over ALCHEMY_DIR", () =>
    Effect.gen(function* () {
      const custom = path.resolve("injected-runtime");
      const directory = yield* dotAlchemyDirectory.pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnv({ env: { ALCHEMY_DIR: "environment-runtime" } }),
        ),
        Effect.provideService(AlchemyContext, {
          dotAlchemy: custom,
          dev: false,
          adopt: false,
        }),
      );

      expect(directory).toBe(custom);
    }),
  );

  it.effect("uses ALCHEMY_DIR for standalone callers without an AlchemyContext", () =>
    Effect.gen(function* () {
      const directory = yield* dotAlchemyDirectory.pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnv({ env: { ALCHEMY_DIR: "standalone-runtime" } }),
        ),
      );

      expect(directory).toBe("standalone-runtime");
    }),
  );

  // Resolved like `ALCHEMY_STAGE`: the shell over `.env`, `--env-file` over the shell.
  const sources = [
    { name: "the shell", shell: "shell", dotEnv: undefined, envFile: undefined, expected: "shell" },
    { name: ".env", shell: undefined, dotEnv: "dotenv", envFile: undefined, expected: "dotenv" },
    {
      name: "the shell over .env",
      shell: "shell",
      dotEnv: "dotenv",
      envFile: undefined,
      expected: "shell",
    },
    {
      name: "--env-file over the shell",
      shell: "shell",
      dotEnv: undefined,
      envFile: "envfile",
      expected: "envfile",
    },
  ] as const;

  for (const runtime of ["bun", "node"] as const)
    for (const source of sources)
      it.live.skipIf(runtime === "node" && !nodeSupportsDevMode)(
        `${runtime} CLI reads ALCHEMY_DIR from ${source.name}`,
        () =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-dir-cli-" });
            const runtimeDir = (name: string) => path.join(root, name, "runtime");
            if (source.dotEnv)
              yield* fs.writeFileString(
                path.join(root, ".env"),
                `ALCHEMY_DIR=${runtimeDir(source.dotEnv)}\n`,
              );
            if (source.envFile)
              yield* fs.writeFileString(
                path.join(root, "app.env"),
                `ALCHEMY_DIR=${runtimeDir(source.envFile)}\n`,
              );
            const args = [cli, "--help", ...(source.envFile ? ["--env-file", "app.env"] : [])];
            const child = yield* ChildProcess.make(
              runtime === "bun" ? "bun" : nodePath!,
              runtime === "bun" ? args : ["--experimental-strip-types", ...args],
              {
                cwd: root,
                env: {
                  ALCHEMY_HOME: path.join(root, "home"),
                  CI: "1",
                  ...(source.shell ? { ALCHEMY_DIR: runtimeDir(source.shell) } : {}),
                },
                extendEnv: true,
                stdin: "ignore",
                stdout: "ignore",
                stderr: "ignore",
                killSignal: "SIGTERM",
                forceKillAfter: "1 second",
              },
            );

            expect(yield* child.exitCode).toBe(0);
            expect(yield* fs.exists(runtimeDir(source.expected))).toBe(true);
            for (const other of ["shell", "dotenv", "envfile"].filter((n) => n !== source.expected))
              expect(yield* fs.exists(path.join(root, other))).toBe(false);
            expect(yield* fs.exists(path.join(root, ".alchemy"))).toBe(false);
          }).pipe(Effect.scoped, Effect.provide(PlatformServices)),
        { timeout: 20_000 },
      );
});
