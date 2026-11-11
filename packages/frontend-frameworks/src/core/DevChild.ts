import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";
/**
 * Child-process isolation for framework DEV servers.
 *
 * Framework toolchains assume `cwd === project root` at dev-server startup
 * (SolidStart resolves the app from the cwd at config-load time, Waku its
 * html shell and relative inputs), and some race when several projects load
 * in one process (SvelteKit's plugin construction, Nuxt's kit caches). The
 * process that hosts dev servers (the alchemy dev sidecar serves every
 * website of a run) must never run them itself. So the CALLER runs each dev
 * server in a dedicated child process whose working directory IS the
 * project root, and framework integrations always serve in-process, in a
 * cwd that is already their root — no chdir anywhere, no lock. The same
 * rule holds for builds (`core/BuildChild.ts`) and for Cloudflare Worker
 * sources (alchemy's Vite child).
 *
 * - The **parent** ({@link runDevChild}) spawns the shared
 *   `core/DevChildRunner.ts` entry with `cwd = rootDir`, forwards the dev
 *   server's output, and resolves once the child prints the
 *   {@link DEV_CHILD_URL_REGEX} readiness marker. The child lives in the
 *   ambient Scope — the same lifetime an in-process dev handle has — and
 *   is stopped (SIGTERM, then SIGKILL) when that scope closes.
 * - The **child** (`DevChildRunner`) imports the framework-integration
 *   module, calls `make(config.makeOptions).dev(config.devOptions)`, prints
 *   the marker, and serves until SIGTERM interrupts it.
 */
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as SemVer from "effect/SemVer";
import * as SemVerRange from "effect/SemVerRange";
import { makeChildOutput } from "./ChildOutput.ts";
import { FrameworkError, type FrameworkDevServer } from "./Framework.ts";

/**
 * Run `effect` only when the process is already in the project root. For
 * toolchains that resolve inputs from `process.cwd()` (Waku, SolidStart):
 * their callers run them in a build or dev child rooted at the project, so
 * a different cwd is a caller bug, reported instead of papered over with a
 * process-wide `chdir`.
 */
export const inProjectCwd = <A, E, R>(
  framework: string,
  root: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | FrameworkError, R> =>
  Effect.suspend((): Effect.Effect<A, E | FrameworkError, R> => {
    const cwd = process.cwd();
    // Compare real paths: the child's cwd is physical, while `root` may go
    // through a symlink (macOS `/tmp`, a linked project directory).
    const real = (dir: string) => {
      try {
        return NodeFs.realpathSync.native(dir);
      } catch {
        return NodePath.resolve(dir);
      }
    };
    return real(cwd) === real(root)
      ? effect
      : Effect.fail(
          new FrameworkError({
            framework,
            message:
              `${framework} must run with its project root (${root}) as the working ` +
              `directory, in a build or dev child process; the working directory is ${cwd}`,
          }),
        );
  });

/** The runner's `argv[2]` payload (JSON). */
export interface DevChildPayload {
  /**
   * Framework-integration module specifier (e.g.
   * `"@alchemy.run/frontend-frameworks/waku"`). Imported by the runner —
   * a bare self-reference resolves within this package.
   */
  readonly module: string;
  /** JSON-serializable options handed to the module's `make(...)`. */
  readonly makeOptions: Record<string, unknown>;
  /** Options handed to the built service's `dev(...)`. */
  readonly devOptions: {
    readonly root: string;
    readonly port?: number | undefined;
    readonly host?: string | undefined;
  };
}

/** Marker line the child prints once the dev server is listening. */
export const DEV_CHILD_URL_REGEX = /<ALCHEMY_DEV_CHILD_URL>(.+)<\/ALCHEMY_DEV_CHILD_URL>/;

export const devChildUrlMarker = (url: string) =>
  `<ALCHEMY_DEV_CHILD_URL>${url}</ALCHEMY_DEV_CHILD_URL>`;

/**
 * `true` when `value` survives a JSON round-trip losslessly — i.e. it
 * contains no functions, symbols, bigints, class instances, or cycles a
 * child process could not reconstruct. Integrations use this to decide
 * whether their `make` options can cross the process boundary; when they
 * cannot (e.g. the e2e harness passes deploy-target VALUES or live vite
 * plugins), `dev` falls back to the in-process path.
 */
export const isJsonSerializable = (value: unknown): boolean => {
  const check = (input: unknown): boolean => {
    if (input === null) return true;
    switch (typeof input) {
      case "string":
      case "number":
      case "boolean":
      case "undefined":
        return true;
      case "object":
        break;
      default:
        return false;
    }
    if (Array.isArray(input)) return input.every(check);
    const proto = Object.getPrototypeOf(input);
    if (proto !== Object.prototype && proto !== null) return false;
    return Object.values(input as Record<string, unknown>).every(check);
  };
  try {
    return check(value);
  } catch {
    // cyclic structures overflow the recursion — not serializable
    return false;
  }
};

/**
 * Node CLI flags that transparently strip TypeScript types, so the `.ts`
 * runner entry works when running from `src/` under plain Node (Bun handles
 * `.ts` natively). Mirrors `core/BuildChild.ts`.
 */
const transformTypesFlags = (): Array<string> =>
  SemVerRange.matches(
    SemVerRange.parseUnsafe(">=22.7.0 <26.0.0-0"),
    SemVer.parseUnsafe(process.versions.node),
    { includePrerelease: true },
  )
    ? ["--experimental-transform-types", "--no-warnings=ExperimentalWarning"]
    : [];

export interface DevChildOptions {
  /** Use Node from PATH for toolchains that cannot run under Bun. Requires native TypeScript support when running source modules. */
  readonly runtime?: "node" | undefined;
  /** Framework name for error attribution (e.g. "solidstart", "waku"). */
  readonly framework: string;
  /** Bare module specifier the runner imports (see {@link DevChildPayload}). */
  readonly module: string;
  /**
   * A module URL the shared runner entry is resolved against, as
   * `../core/DevChildRunner.*` — which lands on the stable entry file in
   * both layouts (`src/{fw}/X.ts` → `src/core/DevChildRunner.ts`,
   * `dist/_chunks/X.js` → `dist/core/DevChildRunner.js`).
   * @default this module's own URL
   */
  readonly callerUrl?: string | undefined;
  /** Project root — becomes the child's working directory. */
  readonly rootDir: string;
  /** JSON-serializable options for the module's `make(...)`. */
  readonly makeOptions: Record<string, unknown>;
  /** Options for the built service's `dev(...)`. */
  readonly devOptions: DevChildPayload["devOptions"];
  /** Environment set on the child, over the parent's own. */
  readonly env?: Record<string, string> | undefined;
}

interface DevChildHandle {
  readonly child: NodeChildProcess.ChildProcess;
  exited: boolean;
  output: string;
}

/**
 * Start a framework dev server in a dedicated child process with
 * `cwd = rootDir` and resolve with its local URL at readiness. The child
 * lives in the ambient Scope; closing it stops the dev server.
 */
export const runDevChild = (
  options: DevChildOptions,
): Effect.Effect<FrameworkDevServer, FrameworkError, Scope.Scope> =>
  Effect.gen(function* () {
    const fail =
      (message: string) =>
      (cause?: unknown): FrameworkError =>
        new FrameworkError({ framework: options.framework, message, cause });

    const entry = fileURLToPath(
      new URL(
        (options.callerUrl ?? import.meta.url).endsWith(".ts")
          ? "../core/DevChildRunner.ts"
          : "../core/DevChildRunner.js",
        options.callerUrl ?? import.meta.url,
      ),
    );
    const isBun =
      options.runtime !== "node" && typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
    const executable = options.runtime === "node" ? "node" : process.execPath;
    const payload: DevChildPayload = {
      module: options.module,
      makeOptions: options.makeOptions,
      devOptions: options.devOptions,
    };
    const args = [
      ...(isBun
        ? ["run"]
        : entry.endsWith(".ts") && options.runtime !== "node"
          ? transformTypesFlags()
          : []),
      entry,
      JSON.stringify(payload),
    ];

    const spawnFailure = fail(`Failed to spawn the ${options.framework} dev child (${executable})`);
    const spawnError = yield* Deferred.make<never, FrameworkError>();
    const handle = yield* Effect.acquireRelease(
      Effect.try({
        try: (): DevChildHandle => {
          const child = NodeChildProcess.spawn(executable, args, {
            cwd: options.rootDir,
            env: options.env === undefined ? process.env : { ...process.env, ...options.env },
            stdio: ["ignore", "pipe", "pipe"],
            detached: false,
          });
          const handle: DevChildHandle = { child, exited: false, output: "" };
          child.on("error", (cause) => {
            Deferred.doneUnsafe(spawnError, Effect.fail(spawnFailure(cause)));
          });
          child.once("exit", () => {
            handle.exited = true;
          });
          return handle;
        },
        catch: spawnFailure,
      }),
      ({ child, exited }) => {
        const stop = (signal: NodeJS.Signals) =>
          Effect.callback<void>((resume) => {
            if (
              child.pid === undefined ||
              exited ||
              child.exitCode !== null ||
              child.signalCode !== null
            ) {
              resume(Effect.void);
              return;
            }
            child.once("exit", () => resume(Effect.void));
            child.kill(signal);
          });
        return stop("SIGTERM").pipe(
          Effect.interruptible,
          Effect.timeoutOrElse({ duration: "3 seconds", orElse: () => stop("SIGKILL") }),
        );
      },
    );

    const output = yield* makeChildOutput;
    const url = yield* Effect.callback<string, FrameworkError>((resume) => {
      const { child } = handle;
      let lineBuffer = "";
      let ready = false;
      const capture = (text: string) => {
        handle.output += text;
        if (handle.output.length > 65536) {
          handle.output = handle.output.slice(-32768);
        }
      };
      // Dev-server output becomes log records (not `stdio: "inherit"`), so
      // the process that renders logs shows it, JSON output carries it, and
      // in-process capture (a test runner's log buffer) sees it.
      child.stdout?.on("data", (chunk: unknown) => {
        const text = String(chunk);
        capture(text);
        if (ready) {
          output.stdout.push(text);
          return;
        }
        lineBuffer += text;
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() ?? "";
        for (const line of lines) {
          const match = line.match(DEV_CHILD_URL_REGEX);
          if (match !== null) {
            ready = true;
            resume(Effect.succeed(match[1]));
          } else {
            output.stdout.push(`${line}\n`);
          }
        }
      });
      child.stderr?.on("data", (chunk: unknown) => {
        const text = String(chunk);
        capture(text);
        output.stderr.push(text);
      });
      // stdio can still deliver data after `exit`; flush once it closes.
      child.once("close", () => {
        output.stdout.flush();
        output.stderr.flush();
      });
      child.once("exit", (code) => {
        if (!ready) {
          resume(
            Effect.fail(
              fail(
                `The ${options.framework} dev child exited with code ${String(code)} before becoming ready:\n${handle.output.slice(-4000)}`,
              )(undefined),
            ),
          );
        }
      });
    }).pipe(Effect.raceFirst(Deferred.await(spawnError)));

    return { url };
  });
