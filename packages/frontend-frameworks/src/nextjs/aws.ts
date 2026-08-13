/**
 * `@alchemy.run/frontend-frameworks/nextjs/aws` — Next.js on AWS Lambda via
 * `@opennextjs/aws`.
 *
 * Unlike the Cloudflare Next.js integration (`./index.ts`, a
 * `Layer<Framework>` over the `@opennextjs/cloudflare` pipeline), this module
 * exports the standalone framework-module contract alchemy's
 * `AWS.Website.Server` resource drives directly: `make(options)` resolves to
 * `{ build, dev }`.
 *
 * - **`build`** drives the `@opennextjs/aws` build CLI (resolved from the
 *   *project's* dependency tree) in a disposable child process — the pipeline
 *   mutates cwd-coupled module state, spawns `next build`, and can
 *   `process.exit(1)`, so it must never run in the calling process. When the
 *   project has no `open-next.config.ts`, a minimal default is generated with
 *   the `aws-lambda-streaming` wrapper so the emitted handler streams on a
 *   Lambda Function URL (`invokeMode: RESPONSE_STREAM`) — and, when
 *   `package.json` has no `build` script, with a `buildCommand` that runs
 *   `next build` through the project's detected package runner
 *   (bunx/npx/yarn/pnpm exec) so the build works without one. After the
 *   build, the
 *   authoritative `.open-next/open-next.output.json` manifest is read to
 *   verify the default origin is a streaming function.
 * - **`dev`** runs the real `next dev` through Next's documented custom-server
 *   API (`next({ dev: true })` + `prepare()` + `getRequestHandler()` on an
 *   http server we own) — plain Node, which is already the AWS Lambda
 *   programming model. Scoped: closing the Scope stops the app and the server.
 *
 * The OpenNext output topology the alchemy composite (`AWS.Website.Nextjs`)
 * deploys from `.open-next/`:
 *
 * - `server-functions/default/` — the SSR server Lambda (`index.handler`)
 * - `image-optimization-function/` — the image optimizer Lambda (sharp, arm64)
 * - `revalidation-function/` — the ISR revalidation consumer Lambda
 * - `assets/` — static assets for the CDN (`_next/static`, `public/`, BUILD_ID)
 * - `cache/` — the ISR/fetch cache seed (uploaded under the cache prefix)
 * - `dynamodb-provider/` — the tag-cache table seed function
 */
import * as FrameworkCore from "../core/index.ts";
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { createRequire } from "node:module";
import type * as NodeChildProcessModule from "node:child_process";
import type * as NodeNet from "node:net";

const fail = (message: string) => (cause: unknown) =>
  new FrameworkCore.FrameworkError({ framework: "nextjs", message, cause });

/** Options for the Next.js AWS framework module. */
export interface NextjsAwsOptions {
  /** Project root. Defaults to the process working directory. */
  readonly root?: string | undefined;
  /**
   * The deploy target module specifier the caller resolved this module as.
   * This module IS the AWS target — the option is accepted (the
   * `AWS.Website.Server` resource always passes it) and ignored.
   */
  readonly target?: string | undefined;
  /**
   * Path of the OpenNext config, relative to the project root. When the file
   * does not exist, a minimal default with the `aws-lambda-streaming` wrapper
   * is generated ({@link DEFAULT_OPEN_NEXT_CONFIG}).
   * @default "open-next.config.ts"
   */
  readonly configPath?: string | undefined;
  /**
   * Extra CLI arguments appended to `open-next build` (e.g.
   * `["--dangerously-use-unsupported-next-version"]`).
   */
  readonly buildArgs?: ReadonlyArray<string> | undefined;
  /**
   * Build configuration.
   */
  readonly build?:
    | {
        /**
         * The command that builds the Next.js app, run by OpenNext from the
         * project root (e.g. `"npx next build --turbopack"`). Takes
         * precedence over the package.json `build` script and a
         * `buildCommand` in `open-next.config.ts`.
         * @default the package.json `build` script, or `next build` via the detected package runner (bunx/npx/yarn/pnpm exec) when there is none
         */
        readonly command?: string | undefined;
      }
    | undefined;
}

/** The default server-module name of the server's Lambda entry (the actual
 * name is derived from `open-next.output.json` after the build). */
export const SERVER_ENTRY_NAME = "server-functions/default/index.mjs";

/**
 * Derive the entry-module name (relative to `.open-next/`) from the output
 * manifest's default origin: `bundle` (e.g. `.open-next/server-functions/
 * default`) plus the file half of `handler` (`index.handler` → `index.mjs`).
 */
export const deriveServerEntryName = (origin: {
  readonly handler?: string;
  readonly bundle?: string;
}): string => {
  const bundle = (origin.bundle ?? ".open-next/server-functions/default")
    .replace(/^\.open-next\//, "")
    .replace(/\/+$/, "");
  const handler = origin.handler ?? "index.handler";
  const file = handler.split(".").slice(0, -1).join(".") || "index";
  return `${bundle}/${file}.mjs`;
};

/**
 * The `buildCommand` fallback for npm projects (and when no lockfile is
 * found). OpenNext's default is `{packager} run build`, which dies with a
 * raw `Script not found "build"` when the script is missing;
 * `npx next build` resolves the project's own `next` regardless.
 */
export const DEFAULT_BUILD_COMMAND = "npx next build";

/** The package manager detected from the project's lockfile. */
export type Packager = "bun" | "npm" | "yarn" | "pnpm";

// Mirrors @opennextjs/aws's findPackagerAndRoot: walk up from the project
// root to the nearest lockfile. bun is checked before yarn because
// `bun install --yarn` can emit a yarn.lock alongside bun's own.
const PACKAGER_LOCKFILES: ReadonlyArray<readonly [string, Packager]> = [
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
  ["package-lock.json", "npm"],
  ["yarn.lock", "yarn"],
  ["pnpm-lock.yaml", "pnpm"],
];

/**
 * Detect the project's package manager the same way OpenNext does (nearest
 * lockfile, walking up), so the default build command uses the runner the
 * rest of the build already agreed on. Falls back to npm.
 */
export const detectPackager: (
  root: string,
) => Effect.Effect<Packager, never, FileSystem.FileSystem | Path.Path> =
  Effect.fnUntraced(function* (root: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    let current = root;
    while (true) {
      for (const [file, packager] of PACKAGER_LOCKFILES) {
        const exists = yield* fs
          .exists(path.join(current, file))
          .pipe(Effect.orElseSucceed(() => false));
        if (exists) return packager;
      }
      const parent = path.dirname(current);
      if (parent === current) return "npm";
      current = parent;
    }
  });

/** The `next build` invocation through the packager's local-binary runner. */
export const defaultBuildCommand = (packager: Packager): string => {
  switch (packager) {
    case "bun":
      return "bunx next build";
    case "pnpm":
      return "pnpm exec next build";
    case "yarn":
      return "yarn next build";
    case "npm":
      return DEFAULT_BUILD_COMMAND;
  }
};

/**
 * Render the minimal `open-next.config.ts` generated when the project has
 * none: the default (and only) server uses the `aws-lambda-streaming`
 * wrapper so the emitted handler wraps `awslambda.streamifyResponse` and
 * expects a Function URL with `invokeMode: RESPONSE_STREAM`. When
 * `buildCommand` is given (the project has no `build` script), it is
 * written into the config so OpenNext runs it instead of `npm run build`.
 */
export const makeDefaultOpenNextConfig = (options?: {
  readonly buildCommand?: string | undefined;
}): string => `// Generated by @alchemy.run/frontend-frameworks/nextjs/aws.
// The default OpenNext config for the AWS topology alchemy deploys: the
// server streams its response on a Lambda Function URL. Edit freely, but
// keep the streaming wrapper — the Function URL is created with
// invokeMode: RESPONSE_STREAM.
const config = {
${
  options?.buildCommand === undefined
    ? ""
    : `  // Your package.json had no "build" script when this file was generated,
  // so the build command is set explicitly.
  buildCommand: ${JSON.stringify(options.buildCommand)},
`
}  default: {
    override: {
      wrapper: "aws-lambda-streaming",
    },
  },
};

export default config;
`;

/** The generated config without an explicit `buildCommand`
 * ({@link makeDefaultOpenNextConfig}). */
export const DEFAULT_OPEN_NEXT_CONFIG = makeDefaultOpenNextConfig();

/**
 * Path (relative to the project root) of the wrapper config generated when
 * `build.command` is set and the project has its own `open-next.config.ts`:
 * it re-exports the user's config with `buildCommand` overridden, so the
 * user's file is never touched.
 */
export const OVERRIDE_OPEN_NEXT_CONFIG_PATH = "open-next.alchemy.config.ts";

/** Render the {@link OVERRIDE_OPEN_NEXT_CONFIG_PATH} wrapper config. */
export const makeOverrideOpenNextConfig = (options: {
  readonly configPath: string;
  readonly buildCommand: string;
}): string => `// Generated by @alchemy.run/frontend-frameworks/nextjs/aws.
// Applies the alchemy-configured build command (build: { command }) on top
// of your ${options.configPath}. Do not edit — regenerated on every build.
import config from "./${options.configPath}";

export default {
  ...config,
  buildCommand: ${JSON.stringify(options.buildCommand)},
};
`;

/**
 * The pre-flight error raised when the project has its own
 * `open-next.config.ts` that sets no `buildCommand` AND its `package.json`
 * has no `build` script — the OpenNext build would die with a raw
 * `Script not found "build"` buried in child-process output.
 */
export const missingBuildScriptMessage = (
  configPath: string,
  command: string = DEFAULT_BUILD_COMMAND,
): string =>
  `Your package.json has no "build" script, so the OpenNext build cannot ` +
  `build your Next.js app. Set \`build: { command: "${command}" }\` ` +
  `on the site, add a \`"build"\` script to package.json, or set ` +
  `\`buildCommand\` in ${configPath}.`;

/** The structural slice of `open-next.output.json` this module reads. */
interface OpenNextOutputManifest {
  readonly origins?: {
    readonly default?: {
      readonly type?: string;
      readonly handler?: string;
      readonly bundle?: string;
      readonly streaming?: boolean;
    };
  };
}

/**
 * Resolve the `@opennextjs/aws` CLI entry (`dist/index.js`, the `open-next`
 * bin) from the *project's* dependency tree. The package's exports map has
 * only a `"./*" -> "./dist/*"` pattern (no `"."` and no `./package.json`
 * subpath), so the `index.js` subpath is the one stable resolvable path.
 */
const resolveOpenNextCli = (root: string) =>
  Effect.try({
    try: () => {
      const require = createRequire(`${root.replace(/\/+$/, "")}/package.json`);
      return require.resolve("@opennextjs/aws/index.js");
    },
    catch: fail(
      `Failed to resolve "@opennextjs/aws" from ${root}. ` +
        "It must be installed in your project (it drives the Next.js build).",
    ),
  });

/**
 * Run `open-next build` in a disposable node child process with the project
 * root as cwd. Output is piped and re-emitted through the parent's own
 * stdout/stderr JS streams (NOT `stdio: "inherit"`) so in-process capture —
 * a test runner's log file — sees the build output.
 */
const runOpenNextBuild = (options: {
  readonly root: string;
  readonly cli: string;
  readonly configPath: string;
  readonly extraArgs: ReadonlyArray<string>;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      // Always plain `node` (never bun/`process.execPath`): the OpenNext CLI
      // mutates its own process.env (NEXT_PRIVATE_STANDALONE,
      // NEXT_PRIVATE_OUTPUT_TRACE_ROOT) before exec'ing `next build`, and
      // those mutations do not reliably reach execSync children under bun.
      const child = yield* ChildProcess.make(
        "node",
        [
          options.cli,
          "build",
          "--config-path",
          options.configPath,
          ...options.extraArgs,
        ],
        {
          cwd: options.root,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      ).pipe(
        Effect.mapError(
          fail(
            "Failed to spawn the @opennextjs/aws build CLI (is `node` on PATH?)",
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
        Effect.mapError(fail("Failed reading the OpenNext build's output")),
      );
      if (exitCode !== 0) {
        return yield* Effect.fail(
          fail(`The OpenNext build exited with code ${exitCode}`)(undefined),
        );
      }
    }),
  );

// ---------------------------------------------------------------------------
// dev — the real `next dev` CLI in a child process
// ---------------------------------------------------------------------------

/**
 * Resolve the *project's* `next` CLI entry (`next/dist/bin/next`). The
 * app's installed copy is the one driven, never a hoisted sibling.
 */
const resolveNextCli = (root: string) =>
  Effect.try({
    try: () => {
      const require = createRequire(`${root.replace(/\/+$/, "")}/package.json`);
      return require.resolve("next/dist/bin/next");
    },
    catch: fail(
      `Failed to resolve "next" from ${root}. ` +
        "It must be installed in your project.",
    ),
  });

/** Bind an ephemeral port and release it, returning the port number. */
const pickEphemeralPort: Effect.Effect<number, FrameworkCore.FrameworkError> =
  Effect.callback((resume) => {
    const net = createRequire(import.meta.url)("net") as typeof NodeNet;
    const server = net.createServer();
    server.once("error", (cause) =>
      resume(Effect.fail(fail("Failed to allocate an ephemeral port")(cause))),
    );
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        resume(Effect.fail(fail("No TCP address for the port probe")(null)));
        return;
      }
      const port = address.port;
      server.close(() => resume(Effect.succeed(port)));
    });
  });

interface NextDevChild {
  readonly exited: () => boolean;
  readonly output: () => string;
}

/**
 * Spawn `node <next CLI> dev -p <port>` with the project root as cwd,
 * scoped: closing the Scope kills the process tree (SIGTERM, then SIGKILL).
 * Always plain `node` — the AWS Lambda programming model.
 */
const spawnNextDev = (options: {
  readonly root: string;
  readonly cli: string;
  readonly port: number;
  readonly host?: string | undefined;
}): Effect.Effect<NextDevChild, FrameworkCore.FrameworkError, Scope.Scope> =>
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
          } satisfies NextDevChild,
        };
      },
      catch: fail("Failed to spawn the next dev CLI (is `node` on PATH?)"),
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
 * Poll the dev server URL until it answers any HTTP response. Fails fast
 * when the child exits before becoming ready.
 */
const awaitNextDevReady = (options: {
  readonly url: string;
  readonly child: NextDevChild;
}): Effect.Effect<void, FrameworkCore.FrameworkError> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 240; attempt++) {
      if (options.child.exited()) {
        return yield* Effect.fail(
          fail(
            `The next dev CLI exited before becoming ready:\n${options.child.output().slice(-4000)}`,
          )(undefined),
        );
      }
      const ready = yield* Effect.tryPromise({
        try: async () => {
          const response = await fetch(options.url, {
            signal: AbortSignal.timeout(2000),
          });
          return response.status < 600;
        },
        catch: () => "not-ready" as const,
      }).pipe(Effect.orElseSucceed(() => false));
      if (ready) return;
      yield* Effect.sleep(500);
    }
    return yield* Effect.fail(
      fail(`Timed out waiting for the next dev server at ${options.url}`)(
        undefined,
      ),
    );
  });

/** The service shape {@link make} resolves to (the framework-module contract
 * `AWS.Website.Server` drives; `serverModules` carries names only — the AWS
 * deploy ships the OpenNext bundles from disk, never in-memory). */
export interface NextjsAwsService {
  readonly build: (
    options?: FrameworkCore.FrameworkBuildOptions,
  ) => Effect.Effect<
    {
      readonly distDirectory: string;
      readonly clientDirectory: string;
      readonly serverModules: Array<{ readonly name: string }>;
    },
    FrameworkCore.FrameworkError
  >;
  readonly dev: (
    options?: FrameworkCore.FrameworkDevOptions,
  ) => Effect.Effect<
    FrameworkCore.FrameworkDevServer,
    FrameworkCore.FrameworkError,
    Scope.Scope
  >;
}

/**
 * Build the Next.js-on-AWS framework service. See the module doc for the
 * `build`/`dev` semantics.
 */
export const make: (
  options?: NextjsAwsOptions,
) => Effect.Effect<NextjsAwsService, never, FileSystem.FileSystem | Path.Path> =
  Effect.fnUntraced(function* (options?: NextjsAwsOptions) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const fsPathLayer = Layer.merge(
      Layer.succeed(FileSystem.FileSystem)(fs),
      Layer.succeed(Path.Path)(path),
    );
    const spawnerLayer = NodeChildProcessSpawner.layer.pipe(
      Layer.provide(fsPathLayer),
    );

    const resolveRoot = (override: string | undefined) =>
      Effect.sync(() =>
        path.resolve(override ?? options?.root ?? process.cwd()),
      );

    const build: NextjsAwsService["build"] = Effect.fn(function* (
      buildOptions?: FrameworkCore.FrameworkBuildOptions,
    ) {
      const root = yield* resolveRoot(buildOptions?.root);
      const configPath = options?.configPath ?? "open-next.config.ts";

      // OpenNext defaults its build command to `{packager} run build`, which
      // dies with a raw `Script not found "build"` when package.json has no
      // build script. Detect that up front so the missing script either gets
      // a working default (generated config) or an actionable error.
      const hasBuildScript = yield* fs
        .readFileString(path.join(root, "package.json"))
        .pipe(
          Effect.flatMap((raw) =>
            Effect.try(() => {
              const parsed = JSON.parse(raw) as {
                scripts?: Record<string, unknown>;
              };
              return typeof parsed.scripts?.build === "string";
            }),
          ),
          Effect.orElseSucceed(() => false),
        );

      // Generate the minimal streaming config when the project has none. The
      // file lands in the project root (OpenNext resolves the config relative
      // to its cwd) and is left in place so subsequent builds — and the memo
      // input hash — see a stable tree.
      const explicitCommand = options?.build?.command;
      const absoluteConfigPath = path.resolve(root, configPath);
      const hasConfig = yield* fs
        .exists(absoluteConfigPath)
        .pipe(Effect.orElseSucceed(() => false));
      const fallbackCommand = defaultBuildCommand(
        yield* detectPackager(root).pipe(Effect.provide(fsPathLayer)),
      );
      if (!hasConfig) {
        yield* fs
          .writeFileString(
            absoluteConfigPath,
            makeDefaultOpenNextConfig({
              buildCommand:
                hasBuildScript || explicitCommand !== undefined
                  ? undefined
                  : fallbackCommand,
            }),
          )
          .pipe(
            Effect.mapError(
              fail(
                `Failed to write the default OpenNext config at ${absoluteConfigPath}`,
              ),
            ),
          );
      }

      // An explicit `build.command` always wins: it is applied through a
      // generated wrapper config that re-exports the (user's or generated)
      // config with `buildCommand` overridden, so no user file is edited.
      let effectiveConfigPath = configPath;
      if (explicitCommand !== undefined) {
        effectiveConfigPath = OVERRIDE_OPEN_NEXT_CONFIG_PATH;
        yield* fs
          .writeFileString(
            path.resolve(root, OVERRIDE_OPEN_NEXT_CONFIG_PATH),
            makeOverrideOpenNextConfig({
              configPath,
              buildCommand: explicitCommand,
            }),
          )
          .pipe(
            Effect.mapError(
              fail(
                `Failed to write the OpenNext build-command override at ${path.resolve(root, OVERRIDE_OPEN_NEXT_CONFIG_PATH)}`,
              ),
            ),
          );
      } else if (hasConfig && !hasBuildScript) {
        const configText = yield* fs
          .readFileString(absoluteConfigPath)
          .pipe(Effect.orElseSucceed(() => ""));
        if (!configText.includes("buildCommand")) {
          return yield* Effect.fail(
            fail(missingBuildScriptMessage(configPath, fallbackCommand))(
              undefined,
            ),
          );
        }
      }

      const cli = yield* resolveOpenNextCli(root);
      yield* runOpenNextBuild({
        root,
        cli,
        configPath: effectiveConfigPath,
        extraArgs: options?.buildArgs ?? [],
      }).pipe(Effect.provide(spawnerLayer));

      const distDirectory = path.join(root, ".open-next");
      const clientDirectory = path.join(distDirectory, "assets");

      // The authoritative manifest: verify the topology the composite deploys
      // (a streaming default server function) actually came out of the build.
      const manifestPath = path.join(distDirectory, "open-next.output.json");
      const manifestRaw = yield* fs
        .readFileString(manifestPath)
        .pipe(Effect.mapError(fail(`The build produced no ${manifestPath}`)));
      const manifest = yield* Effect.try({
        try: () => JSON.parse(manifestRaw) as OpenNextOutputManifest,
        catch: fail(`Failed to parse ${manifestPath}`),
      });
      const defaultOrigin = manifest.origins?.default;
      if (defaultOrigin?.type !== "function") {
        return yield* Effect.fail(
          fail(
            `The OpenNext build's default origin is "${defaultOrigin?.type}", not a Lambda function. ` +
              "The AWS deploy target only supports the function topology (no generateDockerfile).",
          )(undefined),
        );
      }
      if (defaultOrigin.streaming !== true) {
        return yield* Effect.fail(
          fail(
            "The OpenNext build's default server does not stream. The Lambda Function URL is " +
              "created with invokeMode: RESPONSE_STREAM, so open-next.config.ts must keep the streaming wrapper: " +
              '`default: { override: { wrapper: "aws-lambda-streaming" } }`.',
          )(undefined),
        );
      }

      const entryName = deriveServerEntryName(defaultOrigin);
      const entryPath = path.join(distDirectory, entryName);
      if (
        !(yield* fs.exists(entryPath).pipe(Effect.orElseSucceed(() => false)))
      ) {
        return yield* Effect.fail(
          fail(`The build produced no server entry at ${entryPath}`)(undefined),
        );
      }

      return {
        distDirectory,
        clientDirectory,
        serverModules: [{ name: entryName }],
      };
    });

    const dev: NextjsAwsService["dev"] = Effect.fn(function* (
      devOptions?: FrameworkCore.FrameworkDevOptions,
    ) {
      const root = yield* resolveRoot(devOptions?.root);
      const port = devOptions?.port ?? (yield* pickEphemeralPort);
      const cli = yield* resolveNextCli(root);
      const host = devOptions?.host;
      const child = yield* spawnNextDev({ root, cli, port, host });
      const url = `http://${host ?? "localhost"}:${port}`;
      yield* awaitNextDevReady({ url, child });
      return { url };
    });

    return { build, dev };
  });

export default make;
