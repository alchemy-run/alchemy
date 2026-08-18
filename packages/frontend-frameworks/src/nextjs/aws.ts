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
 *   project has no `open-next.config.ts`, a minimal default with the
 *   `aws-lambda-streaming` wrapper is generated under `.alchemy/generated/`
 *   so the emitted handler streams on a Lambda Function URL
 *   (`invokeMode: RESPONSE_STREAM`). With `effect` set (the effectful
 *   single-handler tier, Serve/DESIGN.md), a **derived** config re-points
 *   `default.override.wrapper` at a generated function-form wrapper that
 *   is ADDITIVE-ONLY: the stock streaming wrapper's handler (Next's whole
 *   pipeline, with the user's route-file mount inside) serves ALL HTTP
 *   verbatim, and `makeFrameworkFunctionHandler` from `alchemy/AWS/Serve`
 *   adds the program's non-fetch listener dispatch on the same function;
 *   the site module + serve machinery are prebundled beside the deployed
 *   config (`alchemy-effect.mjs`, kept out of the config compile via
 *   `--node-externals`). After the build, the authoritative
 *   `.open-next/open-next.output.json` manifest is read to verify the
 *   default origin is a streaming function.
 * - **`dev`** runs the real `next dev` through Next's documented custom-server
 *   API (`next({ dev: true })` + `prepare()` + `getRequestHandler()` on an
 *   http server we own, in a spawned `aws-dev-entry.ts` child) — plain Node,
 *   which is already the AWS Lambda programming model. On effectful sites the
 *   user's route-file mount runs natively inside Next's own pipeline (the
 *   mount design — no front dispatch), and Next's compiler hot-reloads the
 *   backend module like any other route dependency. Scoped: closing the
 *   Scope stops the child. `next.config` edits do not auto-restart the
 *   server (documented delta from the CLI).
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
import * as NodeFs from "node:fs";
import type * as NodeNet from "node:net";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";
import { rolldown } from "rolldown";

const fail = (message: string) => (cause: unknown) =>
  new FrameworkCore.FrameworkError({ framework: "nextjs", message, cause });

/**
 * The effectful single-handler delivery inputs (Serve/DESIGN.md, AWS
 * phase 4) — plain JSON, threaded from the `AWS.Website.Nextjs` composite
 * through the `Server` resource's build options. When present, the build
 * passes a **derived** OpenNext config (under `.alchemy/generated/<id>/`)
 * through `--config-path` whose `default.override.wrapper` is a
 * function-form custom wrapper: ADDITIVE-ONLY — Next's handler (with the
 * user's route-file mount inside it) serves ALL HTTP through the stock
 * `aws-lambda-streaming` pipeline verbatim, and
 * `makeFrameworkFunctionHandler` from `alchemy/AWS/Serve` adds the
 * program's non-fetch listener dispatch (queue consumers, schedules) on
 * the SAME function.
 */
export interface NextjsAwsEffectOptions {
  /** The construct id — names the generated `.alchemy/generated/<id>/` dir. */
  readonly id: string;
  /** Absolute path of the user's site module (the `main` impl anchor). */
  readonly main: string;
}

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
   * Path of the project's own OpenNext config, relative to the project
   * root. When the file does not exist, a minimal default with the
   * `aws-lambda-streaming` wrapper is generated under
   * `.alchemy/generated/` ({@link DEFAULT_OPEN_NEXT_CONFIG}) — never in
   * the project root.
   * @default "open-next.config.ts"
   */
  readonly configPath?: string | undefined;
  /**
   * Extra CLI arguments appended to `open-next build` (e.g.
   * `["--dangerously-use-unsupported-next-version"]`).
   */
  readonly buildArgs?: ReadonlyArray<string> | undefined;
  /**
   * Effectful zero-setup delivery ({@link NextjsAwsEffectOptions}). Absent
   * for plain sites; the build is byte-identical to today's without it.
   */
  readonly effect?: NextjsAwsEffectOptions | undefined;
  /**
   * Content hash over the effect module — memo-only (`Server` folds its
   * `options` into the rebuild hash, so effect-module edits rebuild even
   * though the module lives outside the hashed project tree).
   */
  readonly effectHash?: string | undefined;
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
 * The minimal `open-next.config.ts` generated when the project has none:
 * the default (and only) server uses the `aws-lambda-streaming` wrapper so
 * the emitted handler wraps `awslambda.streamifyResponse` and expects a
 * Function URL with `invokeMode: RESPONSE_STREAM`.
 */
export const DEFAULT_OPEN_NEXT_CONFIG = `// Generated by @alchemy.run/frontend-frameworks/nextjs/aws.
// The default OpenNext config for the AWS topology alchemy deploys: the
// server streams its response on a Lambda Function URL. Edit freely, but
// keep the streaming wrapper — the Function URL is created with
// invokeMode: RESPONSE_STREAM.
const config = {
  default: {
    override: {
      wrapper: "aws-lambda-streaming",
    },
  },
};

export default config;
`;

// ---------------------------------------------------------------------------
// Effectful zero-setup delivery (the OpenNext wrapper override)
// ---------------------------------------------------------------------------

/**
 * The prebundled effect module's file name. It is written beside the
 * deployed `open-next.config.mjs` (same directory as the server entry), so
 * the generated wrapper's `import("./alchemy-effect.mjs")` resolves it at
 * cold start; the config compile keeps it external (`--node-externals`).
 */
export const EFFECT_MODULE_NAME = "alchemy-effect.mjs";

/** The generated wrapper module's file name (under `.alchemy/generated/<id>/`). */
export const EFFECT_WRAPPER_NAME = "opennext-wrapper.mjs";

/** The OpenNext version range the wrapper-override delivery is tested against. */
export const OPENNEXT_TESTED_RANGE = "4.x";

/**
 * Version-gate the OpenNext wrapper-override delivery against the
 * *project's* installed `@opennextjs/aws`: the tested major, and the
 * semi-public stock streaming wrapper path the generated wrapper delegates
 * the streamify wrap to (`dist/overrides/wrappers/aws-lambda-streaming.js`,
 * riding the package's `"./*"` exports pattern). Returns the actionable
 * failure message, or `undefined` when supported. Plain (no-impl) builds
 * never consult this.
 */
export const openNextEffectSupportIssue = (cli: string): string | undefined => {
  const optOut =
    "To keep deploying with an untested OpenNext, opt out of auto-injection " +
    "with `server: { takeover: false }` and mount `alchemy/Next` in a " +
    "catch-all route handler instead.";
  const distDir = NodePath.dirname(cli);
  const packageJsonPath = NodePath.join(distDir, "..", "package.json");
  let version: string;
  try {
    version =
      (
        JSON.parse(NodeFs.readFileSync(packageJsonPath, "utf8")) as {
          version?: string;
        }
      ).version ?? "unknown";
  } catch {
    return (
      `Failed to read the installed @opennextjs/aws version at ${packageJsonPath}. ` +
      `Effectful zero-setup delivery for AWS.Website.Nextjs is tested against ` +
      `@opennextjs/aws ${OPENNEXT_TESTED_RANGE}. ${optOut}`
    );
  }
  if (!/^4\./.test(version)) {
    return (
      `Effectful zero-setup delivery for AWS.Website.Nextjs is tested against ` +
      `@opennextjs/aws ${OPENNEXT_TESTED_RANGE}; found ${version}. Pin ` +
      `@opennextjs/aws to ${OPENNEXT_TESTED_RANGE}. ${optOut}`
    );
  }
  const stockWrapper = NodePath.join(
    distDir,
    "overrides",
    "wrappers",
    "aws-lambda-streaming.js",
  );
  if (!NodeFs.existsSync(stockWrapper)) {
    return (
      `@opennextjs/aws@${version} does not ship the stock streaming wrapper at ` +
      `${stockWrapper} (the module the generated alchemy wrapper delegates the ` +
      `awslambda.streamifyResponse wrap to). This alchemy version supports ` +
      `@opennextjs/aws ${OPENNEXT_TESTED_RANGE}. ${optOut}`
    );
  }
  return undefined;
};

/**
 * The generated OpenNext wrapper module (`opennext-wrapper.mjs`): a
 * function-form wrapper override, ADDITIVE-ONLY (Serve/DESIGN.md). The
 * stock `aws-lambda-streaming` wrapper builds Next's own streaming Lambda
 * handler — with the user's route-file mount inside Next's pipeline — and
 * `makeFrameworkFunctionHandler` delegates every HTTP-shaped event to it
 * verbatim while dispatching non-HTTP events (SQS batches, schedules)
 * through the site program's registered listeners on the SAME function.
 *
 * The module's TOP LEVEL IS PURE DATA: `open-next build` evaluates it (the
 * `canStream` probe reads `supportStreaming` to stamp
 * `origins.default.streaming` in the output manifest), so every heavy
 * import is dynamic, cold-start only.
 */
export const generateOpenNextWrapperSource =
  (): string => /* js */ `// Generated by @alchemy.run/frontend-frameworks/nextjs/aws.
// The OpenNext wrapper override for the effectful single-handler tier
// (additive): Next's handler — with the user's route-file mount inside —
// serves ALL HTTP through the stock aws-lambda-streaming pipeline
// verbatim; makeFrameworkFunctionHandler adds the program's non-fetch
// listener dispatch (queue consumers, schedules) on the same function.
// TOP LEVEL IS PURE DATA — the build evaluates this module (the canStream
// probe reads supportStreaming), so every heavy import is dynamic,
// cold-start only.
const wrapper = async (handler, converter) => {
  // Cold start only. The stock wrapper is inlined (lazily) into the
  // compiled open-next.config.mjs by the build's config compile, so this
  // import resolves without node_modules at runtime — and a drifted
  // OpenNext layout fails the build's config compile, never a deployed
  // Lambda.
  const stock = (
    await import("@opennextjs/aws/overrides/wrappers/aws-lambda-streaming.js")
  ).default;
  const streamHandler = await stock.wrapper(handler, converter);
  const { makeFrameworkFunctionHandler, default: Site } = await import(
    "./${EFFECT_MODULE_NAME}"
  );
  return makeFrameworkFunctionHandler({ site: Site, streamHandler });
};

export default {
  wrapper,
  name: "alchemy-effect-streaming",
  supportStreaming: true,
};
`;

/**
 * The derived `open-next.config.ts` passed to the CLI via `--config-path`
 * (always under `.alchemy/generated/<id>/`, never in the project root).
 *
 * Without a user config it is self-contained. With one, it is an
 * import-and-spread merge: the user's config executes unmodified and every
 * field (`functions`, `dangerous`, `buildCommand`, ...) passes through;
 * only `default.override.wrapper` is re-pointed at the generated wrapper.
 * Topologies the wrapper seam cannot compose with — a non-streaming or
 * custom wrapper, the edge runtime, an external middleware origin — refuse
 * loudly at config-compile time with the `takeover: false` + explicit
 * mount fallback.
 */
export const generateDerivedOpenNextConfig = (options: {
  /** Absolute path of the user's own OpenNext config, when one exists. */
  readonly userConfigPath?: string | undefined;
}): string => {
  const wrapperOverride = `wrapper: () => import("./${EFFECT_WRAPPER_NAME}").then((m) => m.default),`;
  if (options.userConfigPath === undefined) {
    return `// Generated by @alchemy.run/frontend-frameworks/nextjs/aws — the derived
// OpenNext config for the effectful zero-setup tier. Regenerated on every
// build; never lands in the project root.
export default {
  default: {
    override: {
      // Function-form override: resolved at runtime (cold start) and by
      // the build's canStream probe — the wrapper module's top level is
      // pure data.
      ${wrapperOverride}
    },
  },
};
`;
  }
  return `// Generated by @alchemy.run/frontend-frameworks/nextjs/aws — the derived
// OpenNext config for the effectful zero-setup tier: your own
// open-next.config.ts executes unmodified and every field passes through;
// only default.override.wrapper is re-pointed at the alchemy wrapper
// (which delegates the streamify wrap to the stock aws-lambda-streaming
// wrapper). Regenerated on every build.
import userConfig from ${JSON.stringify(options.userConfigPath)};

const optOut =
  "To keep this config, opt out of auto-injection with server: " +
  "{ takeover: false } and mount alchemy/Next in a catch-all route " +
  "handler instead.";

const userWrapper = userConfig?.default?.override?.wrapper;
if (userWrapper !== undefined && userWrapper !== "aws-lambda-streaming") {
  throw new Error(
    "[alchemy] open-next.config.ts sets default.override.wrapper to " +
      (typeof userWrapper === "string"
        ? JSON.stringify(userWrapper)
        : "a custom override") +
      '. Effectful AWS.Website.Nextjs composes its dispatch into the stock ' +
      '"aws-lambda-streaming" wrapper (the Function URL is created with ' +
      "invokeMode: RESPONSE_STREAM), so only that wrapper (or none) is " +
      "supported with auto-injection. " +
      optOut,
  );
}
if (userConfig?.default?.runtime === "edge") {
  throw new Error(
    "[alchemy] open-next.config.ts sets the default function's runtime to " +
      '"edge". The effectful AWS.Website.Nextjs wrapper seam only exists on ' +
      "the node runtime. " +
      optOut,
  );
}
if (
  Object.values(userConfig?.functions ?? {}).some(
    (fn) => fn?.runtime === "edge",
  )
) {
  throw new Error(
    "[alchemy] open-next.config.ts declares an edge-runtime split function. " +
      "AWS.Website.Nextjs deploys only the default node server function, and " +
      "the effectful wrapper seam does not exist on the edge runtime. " +
      optOut,
  );
}
if (userConfig?.middleware?.external === true) {
  throw new Error(
    "[alchemy] open-next.config.ts sets middleware.external: true — a " +
      "separate middleware origin AWS.Website.Nextjs does not deploy. " +
      optOut,
  );
}

export default {
  ...userConfig,
  default: {
    ...userConfig?.default,
    override: {
      ...userConfig?.default?.override,
      ${wrapperOverride}
    },
  },
};
`;
};

/**
 * The rolldown prebundle entry: ONE bundle carries both the user's site
 * module and alchemy's AWS serve shell so Context tag identities, the
 * per-class WeakMap memos, and the runtime flag stay singleton — two
 * separate bundles would split module identity between the shell and the
 * site graph and break layer resolution.
 */
export const generateEffectEntrySource = (mainPath: string): string =>
  `// Generated by @alchemy.run/frontend-frameworks/nextjs/aws — the rolldown
// prebundle entry for the effectful single-handler tier (one bundle keeps
// the serve machinery and the site module in a single module graph).
export { makeFrameworkFunctionHandler } from "alchemy/AWS/Serve";
export { default } from ${JSON.stringify(mainPath)};
`;

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
// dev — the real `next dev` (custom-server API) in an alchemy-owned plain
// node child (`aws-dev-entry.ts`)
// ---------------------------------------------------------------------------

/**
 * Node CLI flags that transparently transform TypeScript types, so the
 * `.ts` dev entry (running from `src/` in this workspace) and the user's
 * TypeScript backend module both load under plain Node. Mirrors alchemy's
 * `Util/Node.transformTypesFlags`.
 */
const transformTypesFlags = (): Array<string> => {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  return (major === 22 && minor >= 7) || (major >= 23 && major < 26)
    ? ["--experimental-transform-types", "--no-warnings=ExperimentalWarning"]
    : [];
};

/**
 * Resolve the dev child entry beside this module — `src/nextjs/aws.ts` →
 * `src/nextjs/aws-dev-entry.ts` and `dist/nextjs/aws.js` →
 * `dist/nextjs/aws-dev-entry.js` (a dedicated tsdown entry, like
 * `core/BuildChildRunner`). Lazy: `import.meta.resolve` does not exist in
 * every bundled environment this module can be carried into.
 */
const resolveDevEntry = Effect.try({
  try: () => {
    const url = new URL(
      import.meta.url.endsWith(".ts")
        ? "./aws-dev-entry.ts"
        : "./aws-dev-entry.js",
      import.meta.url,
    );
    return fileURLToPath(url);
  },
  catch: fail("Failed to resolve the Next.js dev child entry"),
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
 * Spawn the alchemy-owned dev child — `node [transform-types]
 * <aws-dev-entry> <configJson>` — with the project root as cwd, scoped:
 * closing the Scope kills the process (SIGTERM, then SIGKILL). Always
 * plain `node` (never bun): Node is the AWS Lambda programming model,
 * node's type transform loads the TypeScript backend, and node's
 * query-keyed ESM cache powers the effect-handler hot reload.
 *
 * The child embeds Next through the documented custom-server API; on
 * effectful sites the user's route-file mount runs natively inside Next's
 * own pipeline (no front dispatch — the mount design). One known delta
 * from the retired `next dev` CLI child: `next.config` edits no longer
 * auto-restart the server (the CLI's parent restart loop is not
 * replicated; restart `alchemy dev`).
 */
const spawnNextDev = (options: {
  readonly root: string;
  readonly entry: string;
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
            ...transformTypesFlags(),
            options.entry,
            JSON.stringify({
              root: options.root,
              port: options.port,
              hostname: options.host,
            }),
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
      catch: fail("Failed to spawn the next dev child (is `node` on PATH?)"),
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
            `The next dev child exited before becoming ready:\n${options.child.output().slice(-4000)}`,
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

    const spawnerLayer = NodeChildProcessSpawner.layer.pipe(
      Layer.provide(
        Layer.merge(
          Layer.succeed(FileSystem.FileSystem)(fs),
          Layer.succeed(Path.Path)(path),
        ),
      ),
    );

    const resolveRoot = (override: string | undefined) =>
      Effect.sync(() =>
        path.resolve(override ?? options?.root ?? process.cwd()),
      );

    const build: NextjsAwsService["build"] = Effect.fn(function* (
      buildOptions?: FrameworkCore.FrameworkBuildOptions,
    ) {
      const root = yield* resolveRoot(buildOptions?.root);
      const userConfigRelative = options?.configPath ?? "open-next.config.ts";
      const userConfigPath = path.resolve(root, userConfigRelative);
      const hasUserConfig = yield* fs
        .exists(userConfigPath)
        .pipe(Effect.orElseSucceed(() => false));

      const cli = yield* resolveOpenNextCli(root);

      // Effectful single-handler delivery (Serve/DESIGN.md): additive-only
      // — the user's route-file mount rides Next's own pipeline, so there
      // is no stand-down scan and nothing to detect.
      const effect = options?.effect;

      const writeGeneratedConfig = (directory: string, content: string) =>
        fs
          .makeDirectory(directory, { recursive: true })
          .pipe(
            Effect.andThen(
              fs.writeFileString(
                path.join(directory, "open-next.config.ts"),
                content,
              ),
            ),
            Effect.mapError(
              fail(
                `Failed to write the derived OpenNext config in ${directory}`,
              ),
            ),
            Effect.as(
              path.relative(root, path.join(directory, "open-next.config.ts")),
            ),
          );

      // Resolve the config the CLI compiles (`--config-path` is joined to
      // the project root, so always a root-relative path):
      //  - effect active -> the derived config under
      //    `.alchemy/generated/<id>/` (imports + spreads the user's own
      //    config when one exists)
      //  - plain with a user config -> the user's config, untouched
      //  - plain without one -> the minimal streaming default, generated
      //    under `.alchemy/generated/` (never in the project root)
      let configPath = userConfigRelative;
      const extraArgs = [...(options?.buildArgs ?? [])];
      if (effect !== undefined) {
        const issue = yield* Effect.sync(() => openNextEffectSupportIssue(cli));
        if (issue !== undefined) {
          return yield* Effect.fail(fail(issue)(undefined));
        }
        const generatedDir = path.join(
          root,
          ".alchemy",
          "generated",
          effect.id,
        );
        yield* fs
          .makeDirectory(generatedDir, { recursive: true })
          .pipe(
            Effect.andThen(
              fs.writeFileString(
                path.join(generatedDir, EFFECT_WRAPPER_NAME),
                generateOpenNextWrapperSource(),
              ),
            ),
            Effect.mapError(
              fail(
                `Failed to write the generated OpenNext wrapper in ${generatedDir}`,
              ),
            ),
          );
        configPath = yield* writeGeneratedConfig(
          generatedDir,
          generateDerivedOpenNextConfig({
            userConfigPath: hasUserConfig ? userConfigPath : undefined,
          }),
        );
        // Keep the prebundled effect module external in the config
        // compile — the deployed open-next.config.mjs imports it beside
        // itself instead (the multi-MB graph never rides the sibling
        // image/revalidation/warmer bundles).
        extraArgs.push("--node-externals", `./${EFFECT_MODULE_NAME}`);
      } else if (!hasUserConfig) {
        configPath = yield* writeGeneratedConfig(
          path.join(root, ".alchemy", "generated", "open-next"),
          DEFAULT_OPEN_NEXT_CONFIG,
        );
      }

      yield* runOpenNextBuild({
        root,
        cli,
        configPath,
        extraArgs,
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

      // Effectful zero-setup: prebundle the site module + alchemy's AWS
      // serve shell into one self-contained node bundle beside the
      // deployed open-next.config.mjs (which the build copies next to the
      // server entry) — the generated wrapper's
      // `import("./alchemy-effect.mjs")` resolves there at cold start. A
      // finishing pass that only ADDS files beside the untouched
      // pre-streamified entry (the Lambda ships the directory as-is,
      // `bundle: false`).
      if (effect !== undefined) {
        const mainPath = effect.main;
        const entrySourcePath = path.join(
          root,
          ".alchemy",
          "generated",
          effect.id,
          "alchemy-effect-entry.mjs",
        );
        yield* fs
          .writeFileString(entrySourcePath, generateEffectEntrySource(mainPath))
          .pipe(
            Effect.mapError(
              fail(
                `Failed to write the effect prebundle entry at ${entrySourcePath}`,
              ),
            ),
          );
        const serverBundleDir = path.dirname(entryPath);
        yield* Effect.tryPromise({
          try: async () => {
            // Resolve with the `bun` condition FIRST (mirroring
            // `FunctionBundle`) so alchemy and distilled bundle from `src`
            // in a workspace — a regenerated service is immediately
            // build-visible without a `lib` rebuild — and fold the runtime
            // flag so plan-only `host.bind` branches DCE out of the
            // shipped bundle.
            const bundle = await rolldown({
              cwd: root,
              input: entrySourcePath,
              platform: "node",
              resolve: {
                conditionNames: ["bun", "node", "import", "module"],
              },
              external: [/^@aws-sdk\//, /^node:/],
              transform: {
                define: {
                  "globalThis.__ALCHEMY_RUNTIME__": "true",
                },
              },
            });
            try {
              await bundle.write({
                dir: serverBundleDir,
                format: "esm",
                entryFileNames: EFFECT_MODULE_NAME,
                chunkFileNames: "alchemy-effect-chunks/[name].mjs",
                sourcemap: false,
              });
            } finally {
              await bundle.close();
            }
          },
          catch: fail(
            "Failed to prebundle the effect module for the OpenNext wrapper",
          ),
        });
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
      const entry = yield* resolveDevEntry;
      const host = devOptions?.host;
      const child = yield* spawnNextDev({ root, entry, port, host });
      const url = `http://${host ?? "localhost"}:${port}`;
      yield* awaitNextDevReady({ url, child });
      return { url };
    });

    return { build, dev };
  });

export default make;
