/**
 * Shared vinext CLI helpers for the Node and AWS framework modules.
 *
 * Cloudflare uses `./source` (Vite + the Alchemy Cloudflare plugin).
 * Node/AWS run the project's own `vinext` CLI: `vinext build` in a
 * disposable child, `vinext dev` scoped under `alchemy dev`.
 */
import * as FrameworkCore from "../core/index.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { createRequire } from "node:module";
import type * as NodeChildProcessModule from "node:child_process";
import type * as NodeNet from "node:net";
import { findEphemeralPort } from "../core/DevPort.ts";
import { toOutputFile, type BuildOutput } from "../core/index.ts";

export const failFramework = (message: string) => (cause: unknown) =>
  new FrameworkCore.FrameworkError({ framework: "vinext", message, cause });

/** App Router RSC entry vinext writes under `dist/server`. */
export const VINEXT_RSC_ENTRY = "server/index.js";

/** Pages Router server entry vinext writes under `dist/server`. */
export const VINEXT_PAGES_ENTRY = "server/entry.js";

export const resolveVinextCli = (root: string) =>
  Effect.try({
    try: () => {
      const require = createRequire(`${root.replace(/\/+$/, "")}/package.json`);
      return require.resolve("vinext/dist/cli.js");
    },
    catch: failFramework(
      `Failed to resolve "vinext" from ${root}. ` +
        "It must be installed in your project.",
    ),
  });

export const runVinextBuild = (options: {
  readonly root: string;
  readonly cli: string;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const env = yield* Effect.sync(() => ({
        ...process.env,
        NODE_ENV: "production",
      }));
      const child = yield* ChildProcess.make("node", [options.cli, "build"], {
        cwd: options.root,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env,
      }).pipe(
        Effect.mapError(
          failFramework(
            "Failed to spawn the vinext build CLI (is `node` on PATH?)",
          ),
        ),
      );
      const forward = (
        stream: Stream.Stream<Uint8Array, PlatformError>,
        dest: NodeJS.WriteStream,
      ) =>
        Stream.runForEach(stream, (chunk) =>
          Effect.sync(() => dest.write(chunk)),
        );
      const { exitCode } = yield* Effect.all(
        {
          exitCode: child.exitCode,
          stdout: forward(child.stdout, process.stdout),
          stderr: forward(child.stderr, process.stderr),
        },
        { concurrency: "unbounded" },
      ).pipe(
        Effect.mapError(failFramework("Failed reading vinext build output")),
      );
      if (exitCode !== 0) {
        return yield* Effect.fail(
          failFramework(`The vinext build exited with code ${exitCode}`)(
            undefined,
          ),
        );
      }
    }),
  );

export const collectVinextDist = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const distDir = path.join(root, "dist");
    const serverDir = path.join(distDir, "server");
    const clientDir = path.join(distDir, "client");
    const rscEntry = path.join(distDir, VINEXT_RSC_ENTRY);
    const pagesEntry = path.join(distDir, VINEXT_PAGES_ENTRY);
    const hasDist = yield* fs
      .exists(distDir)
      .pipe(Effect.orElseSucceed(() => false));
    if (!hasDist) {
      return yield* Effect.fail(
        failFramework(`The vinext build produced no ${distDir}`)(undefined),
      );
    }
    const hasRsc = yield* fs
      .exists(rscEntry)
      .pipe(Effect.orElseSucceed(() => false));
    const hasPages = yield* fs
      .exists(pagesEntry)
      .pipe(Effect.orElseSucceed(() => false));
    if (!hasRsc && !hasPages) {
      return yield* Effect.fail(
        failFramework(
          `The vinext build produced no server entry at ${rscEntry} or ${pagesEntry}`,
        )(undefined),
      );
    }
    const hasClient = yield* fs
      .exists(clientDir)
      .pipe(Effect.orElseSucceed(() => false));
    yield* fs
      .writeFileString(
        path.join(serverDir, "package.json"),
        `${JSON.stringify({ type: "module" }, null, 2)}\n`,
      )
      .pipe(
        Effect.mapError(
          failFramework("Failed to write dist/server/package.json"),
        ),
      );
    return {
      distDirectory: distDir,
      clientDirectory: hasClient ? clientDir : undefined,
      serverDir,
      hasRsc,
      hasPages,
    };
  });

export const pinServeModule = (
  output: Omit<BuildOutput, "serverModules" | "externalWorkspaces"> & {
    readonly serverDir: string;
  },
  serveModuleName: string,
  serveSource: string,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const servePath = path.join(
      output.serverDir,
      path.basename(serveModuleName),
    );
    yield* fs
      .writeFileString(servePath, serveSource)
      .pipe(
        Effect.mapError(
          failFramework(`Failed to write the serve entry at ${servePath}`),
        ),
      );
    const serveModule = yield* toOutputFile(serveModuleName, serveSource);
    return {
      distDirectory: output.distDirectory,
      clientDirectory: output.clientDirectory,
      serverModules: [serveModule],
      externalWorkspaces: new Set<string>(),
    } satisfies BuildOutput;
  });

export interface VinextDevChild {
  readonly exited: () => boolean;
  readonly output: () => string;
}

export const spawnVinextDev = (options: {
  readonly root: string;
  readonly cli: string;
  readonly port: number;
  readonly host?: string | undefined;
}): Effect.Effect<VinextDevChild, FrameworkCore.FrameworkError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.try({
      try: () => {
        const cp = createRequire(import.meta.url)(
          "child_process",
        ) as typeof NodeChildProcessModule;
        const child = cp.spawn(
          "node",
          [
            options.cli,
            "dev",
            "-p",
            String(options.port),
            ...(options.host !== undefined ? ["-H", options.host] : []),
          ],
          {
            cwd: options.root,
            stdio: ["ignore", "pipe", "pipe"],
            detached: false,
          },
        );
        let exited = false;
        let output = "";
        const capture = (chunk: unknown) => {
          output += String(chunk);
          if (output.length > 65536) output = output.slice(-32768);
          process.stderr.write(String(chunk));
        };
        child.stdout?.on("data", capture);
        child.stderr?.on("data", capture);
        child.once("exit", () => {
          exited = true;
        });
        return {
          child,
          handle: {
            exited: () => exited,
            output: () => output,
          } satisfies VinextDevChild,
        };
      },
      catch: failFramework(
        "Failed to spawn the vinext dev CLI (is `node` on PATH?)",
      ),
    }),
    ({ child }) =>
      Effect.callback<void>((resume) => {
        if (child.exitCode !== null) {
          resume(Effect.void);
          return;
        }
        const killTimer = setTimeout(() => child.kill("SIGKILL"), 3000);
        child.once("exit", () => {
          clearTimeout(killTimer);
          resume(Effect.void);
        });
        child.kill("SIGTERM");
      }),
  ).pipe(Effect.map(({ handle }) => handle));

/**
 * Poll until the allocated port accepts a TCP connection. vinext/Vite can
 * bind before the first App Router compile finishes, so an HTTP GET with
 * a short abort restarts that compile and never converges.
 */
export const awaitVinextDevReady = (options: {
  readonly url: string;
  readonly child: VinextDevChild;
}): Effect.Effect<void, FrameworkCore.FrameworkError> =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => new URL(options.url),
      catch: failFramework(`Invalid vinext dev URL: ${options.url}`),
    });
    const port = Number(parsed.port);
    const hostname = parsed.hostname;
    for (let attempt = 0; attempt < 240; attempt++) {
      if (options.child.exited()) {
        return yield* Effect.fail(
          failFramework(
            `The vinext dev CLI exited before becoming ready:\n${options.child.output().slice(-4000)}`,
          )(undefined),
        );
      }
      const ready = yield* Effect.callback<boolean>((resume) => {
        const net = createRequire(import.meta.url)("net") as typeof NodeNet;
        let settled = false;
        const finish = (value: boolean) => {
          if (settled) return;
          settled = true;
          resume(Effect.succeed(value));
        };
        const socket = net.connect({ host: hostname, port }, () => {
          socket.destroy();
          finish(true);
        });
        socket.setTimeout(2000, () => {
          socket.destroy();
          finish(false);
        });
        socket.once("error", () => {
          socket.destroy();
          finish(false);
        });
        return Effect.sync(() => {
          settled = true;
          socket.destroy();
        });
      });
      if (ready) return;
      yield* Effect.sleep(500);
    }
    return yield* Effect.fail(
      failFramework(
        `Timed out waiting for the vinext dev server at ${options.url}`,
      )(undefined),
    );
  });

export const pickEphemeralPort: Effect.Effect<
  number,
  FrameworkCore.FrameworkError
> = findEphemeralPort();
