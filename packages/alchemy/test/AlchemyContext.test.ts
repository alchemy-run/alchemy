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

  for (const runtime of ["bun", "node"] as const) {
    it.live.skipIf(runtime === "node" && !nodeSupportsDevMode)(
      `${runtime} CLI creates only the configured runtime directory`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-dir-cli-" });
          const directory = path.join(root, "custom", "runtime");
          const child = yield* ChildProcess.make(
            runtime === "bun" ? "bun" : nodePath!,
            runtime === "bun" ? [cli, "--help"] : ["--experimental-strip-types", cli, "--help"],
            {
              cwd: root,
              env: {
                ALCHEMY_DIR: directory,
                ALCHEMY_HOME: path.join(root, "home"),
                CI: "1",
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
          expect(yield* fs.exists(directory)).toBe(true);
          expect(yield* fs.exists(path.join(root, ".alchemy"))).toBe(false);
        }).pipe(Effect.scoped, Effect.provide(PlatformServices)),
      { timeout: 20_000 },
    );
  }
});
