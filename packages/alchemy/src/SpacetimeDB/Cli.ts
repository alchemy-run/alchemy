import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import {
  ChildProcessSpawner,
  type ExitCode,
} from "effect/unstable/process/ChildProcessSpawner";
import type { PlatformError } from "effect/PlatformError";
import { SpacetimeDBCredentials } from "./Credentials.ts";
import { DEFAULT_HOST, normalizeHost } from "./Host.ts";

export class SpacetimeCliError extends Data.TaggedError("SpacetimeCliError")<{
  readonly command: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  override get message() {
    const detail = this.stderr.trim() || this.stdout.trim() || "(no output)";
    return `spacetime ${this.command} exited ${this.exitCode}: ${detail}`;
  }
}

export class SpacetimeCliNotFound extends Data.TaggedError(
  "SpacetimeCliNotFound",
)<{
  readonly message: string;
}> {}

export type ClearDataMode = "always" | "on-conflict" | "never" | boolean;

/**
 * Normalize clear-data prop to the CLI `--delete-data` value.
 * `true` → `always`, `false`/undefined → omitted (never clear).
 */
export const clearDataFlag = (
  clearData: ClearDataMode | undefined,
): string | undefined => {
  if (clearData === undefined || clearData === false || clearData === "never") {
    return undefined;
  }
  if (clearData === true || clearData === "always") return "always";
  return clearData;
};

export interface PublishViaCliOptions {
  readonly database: string;
  readonly modulePath?: string;
  readonly binPath?: string;
  readonly jsPath?: string;
  readonly host?: string;
  readonly clearData?: ClearDataMode;
  readonly breakClients?: boolean;
  readonly organization?: string;
  readonly parent?: string;
  readonly anonymous?: boolean;
  readonly buildOptions?: string;
  readonly cwd?: string;
}

export interface PublishViaCliResult {
  readonly databaseIdentity: string | undefined;
  readonly stdout: string;
  readonly stderr: string;
}

const sha256Hex = (bytes: Uint8Array): string => {
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  return createHash("sha256").update(bytes).digest("hex");
};

export const hashModuleSource = (
  modulePath: string | undefined,
  binPath: string | undefined,
  jsPath: string | undefined,
  database: string | undefined,
): Effect.Effect<string, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    if (binPath || jsPath) {
      const target = (binPath ?? jsPath)!;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const resolved = path.isAbsolute(target)
        ? target
        : path.resolve(yield* Effect.sync(() => process.cwd()), target);
      return yield* fs.readFile(resolved).pipe(
        Effect.map(sha256Hex),
        Effect.orElseSucceed(() => ""),
      );
    }
    if (!modulePath) {
      // Database-only (live) — no local content. Capture cwd's FileSystem/Path
      // via a probe so the outer Effect gets the right R.
      yield* FileSystem.FileSystem;
      yield* Path.Path;
      return database ?? "";
    }
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = path.resolve(
      yield* Effect.sync(() => process.cwd()),
      modulePath,
    );
    return yield* fs.stat(root).pipe(
      Effect.flatMap((stat) =>
        stat.type === "Directory"
          ? walk(root)
          : fs.readFile(root).pipe(
              Effect.map(sha256Hex),
              Effect.orElseSucceed(() => ""),
            ),
      ),
      Effect.orElseSucceed(() => ""),
    );
  });

const walk = (
  root: string,
): Effect.Effect<string, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const entries = yield* fs
      .readDirectory(root)
      .pipe(Effect.orElseSucceed(() => []));
    let acc = root;
    for (const entry of entries) {
      if (
        entry === "node_modules" ||
        entry === "target" ||
        entry === "dist" ||
        entry === ".git"
      ) {
        continue;
      }
      const full = path.join(root, entry);
      const stat = yield* fs.stat(full).pipe(Effect.orElseSucceed(() => null));
      if (!stat) continue;
      if (stat.type === "Directory") {
        acc += "|" + (yield* walk(full));
      } else if (/\.(ts|rs|cs|cpp|toml|json)$/.test(entry)) {
        const content = yield* fs.readFile(full).pipe(
          Effect.map(sha256Hex),
          Effect.orElseSucceed(() => ""),
        );
        acc += "|" + entry + ":" + content;
      }
    }
    return acc;
  });

const tokenEnv = Effect.gen(function* () {
  const env: Record<string, string> = {};
  const creds = yield* Effect.serviceOption(SpacetimeDBCredentials);
  if (Option.isSome(creds)) {
    const service = yield* creds.value;
    const token = Redacted.value(service.token);
    env.SPACETIMEDB_TOKEN = token;
    env.SPACETIME_TOKEN = token;
  }
  return env;
});

/**
 * Run a `spacetime …` subprocess and capture stdout/stderr. Requires the
 * `spacetime` CLI on `PATH` (https://spacetimedb.com/install).
 */
export const runSpacetime = (
  args: ReadonlyArray<string>,
  options?: {
    readonly cwd?: string;
    readonly env?: Record<string, string>;
    readonly timeout?: Duration.Input;
  },
): Effect.Effect<
  { exitCode: ExitCode; stdout: string; stderr: string },
  PlatformError | SpacetimeCliError | SpacetimeCliNotFound,
  ChildProcessSpawner
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner;
      const handle = yield* spawner
        .spawn(
          ChildProcess.make("spacetime", [...args], {
            cwd: options?.cwd,
            env: options?.env,
            extendEnv: true,
            shell: false,
          }),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new SpacetimeCliNotFound({
                message: `Could not invoke \`spacetime\`. Install the SpacetimeDB CLI from https://spacetimedb.com/install (${String(cause)})`,
              }),
          ),
        );

      const collect = Effect.all(
        [
          handle.exitCode,
          Stream.mkString(Stream.decodeText(handle.stdout)),
          Stream.mkString(Stream.decodeText(handle.stderr)),
        ],
        { concurrency: 3 },
      );

      const timed =
        options?.timeout !== undefined
          ? collect.pipe(
              Effect.timeoutOption(options.timeout),
              Effect.flatMap(
                Option.match({
                  onNone: () =>
                    Effect.fail(
                      new SpacetimeCliError({
                        command: args.join(" "),
                        exitCode: -1,
                        stdout: "",
                        stderr: `timed out after ${String(options.timeout)}`,
                      }),
                    ),
                  onSome: (triple) => Effect.succeed(triple),
                }),
              ),
            )
          : collect;

      const [exitCode, stdout, stderr] = yield* timed;
      return { exitCode, stdout, stderr };
    }),
  );

/**
 * `spacetime build -p <modulePath>`.
 */
export const buildViaCli = (
  modulePath: string,
  options?: { readonly buildOptions?: string; readonly cwd?: string },
) =>
  Effect.gen(function* () {
    const args = ["build", "--module-path", modulePath];
    if (options?.buildOptions) {
      args.push("--build-options", options.buildOptions);
    }
    const result = yield* runSpacetime(args, {
      cwd: options?.cwd,
      timeout: "5 minutes",
    });
    if (result.exitCode !== 0) {
      return yield* Effect.fail(
        new SpacetimeCliError({ command: args.join(" "), ...result }),
      );
    }
    return result;
  });

/**
 * `spacetime generate` for client bindings.
 */
export const generateViaCli = (options: {
  readonly lang: string;
  readonly outDir: string;
  readonly modulePath?: string;
  readonly binPath?: string;
  readonly jsPath?: string;
  readonly database?: string;
  readonly cwd?: string;
  readonly includePrivate?: boolean;
}) =>
  Effect.gen(function* () {
    const args = [
      "generate",
      "--lang",
      options.lang,
      "--out-dir",
      options.outDir,
      "--yes",
    ];
    if (options.modulePath) args.push("--module-path", options.modulePath);
    if (options.binPath) args.push("--bin-path", options.binPath);
    if (options.jsPath) args.push("--js-path", options.jsPath);
    if (options.database) args.push(options.database);
    if (options.includePrivate) args.push("--include-private");
    const result = yield* runSpacetime(args, {
      cwd: options.cwd,
      timeout: "5 minutes",
    });
    if (result.exitCode !== 0) {
      return yield* new SpacetimeCliError({
        command: args.join(" "),
        ...result,
      });
    }
    return result;
  });

/**
 * Publish a module via the `spacetime` CLI. Prefer this when a `modulePath`
 * is set (the CLI owns language-specific builds). Injects the Alchemy-resolved
 * token so CI works without a separate interactive `spacetime login`.
 */
export const publishViaCli = (options: PublishViaCliOptions) =>
  Effect.gen(function* () {
    const host = yield* normalizeHost(options.host ?? DEFAULT_HOST);
    const args = ["publish", options.database, "--server", host, "--yes=all"];

    if (options.modulePath) args.push("--module-path", options.modulePath);
    if (options.binPath) args.push("--bin-path", options.binPath);
    if (options.jsPath) args.push("--js-path", options.jsPath);
    if (options.breakClients) args.push("--break-clients");
    if (options.organization) args.push("--organization", options.organization);
    if (options.parent) args.push("--parent", options.parent);
    if (options.anonymous) args.push("--anonymous");
    if (options.buildOptions) {
      args.push("--build-options", options.buildOptions);
    }
    const clear = clearDataFlag(options.clearData);
    if (clear) args.push("--delete-data", clear);

    const env = yield* tokenEnv;
    const result = yield* runSpacetime(args, {
      cwd: options.cwd,
      env,
      timeout: "10 minutes",
    });
    if (result.exitCode !== 0) {
      return yield* new SpacetimeCliError({
        command: args.join(" "),
        ...result,
      });
    }

    return {
      databaseIdentity: scrapeIdentity(result.stdout + "\n" + result.stderr),
      stdout: result.stdout,
      stderr: result.stderr,
    } satisfies PublishViaCliResult;
  });

/**
 * `spacetime delete <database> --server <host> --yes`
 */
export const deleteViaCli = (options: {
  readonly database: string;
  readonly host?: string;
}) =>
  Effect.gen(function* () {
    const host = yield* normalizeHost(options.host ?? DEFAULT_HOST);
    const args = ["delete", options.database, "--server", host, "--yes"];
    const env = yield* tokenEnv;
    const result = yield* runSpacetime(args, {
      env,
      timeout: "2 minutes",
    });
    if (result.exitCode !== 0) {
      const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
      if (
        combined.includes("not found") ||
        combined.includes("no such") ||
        combined.includes("does not exist")
      ) {
        return result;
      }
      return yield* new SpacetimeCliError({
        command: args.join(" "),
        ...result,
      });
    }
    return result;
  });

/**
 * Best-effort scrape of a hex database identity from CLI output.
 */
export const scrapeIdentity = (text: string): string | undefined => {
  const labeled =
    text.match(
      /(?:database[_\s-]?identity|identity)\s*[:=]?\s*([0-9a-fA-F]{16,})/i,
    ) ?? text.match(/\b([0-9a-fA-F]{32,})\b/);
  return labeled?.[1];
};

/**
 * Args for a long-lived local dev process (`spacetime dev --server-only`).
 * Used by the local Database provider during `alchemy dev`.
 */
export const localDevArgs = (options: {
  readonly database: string;
  readonly modulePath?: string;
  readonly binPath?: string;
  readonly jsPath?: string;
  readonly clearData?: ClearDataMode;
  readonly host?: string;
}): string[] => {
  const host = options.host ?? "local";
  const args = [
    "dev",
    options.database,
    "--server",
    host,
    "--server-only",
    "--yes",
  ];
  if (options.modulePath) args.push("--module-path", options.modulePath);
  if (options.binPath) args.push("--bin-path", options.binPath);
  if (options.jsPath) args.push("--js-path", options.jsPath);
  const clear = clearDataFlag(options.clearData);
  if (clear) args.push("--delete-data", clear);
  return args;
};

/**
 * `spacetime rename --to <newName> <databaseIdentity>`
 */
export const renameViaCli = (options: {
  readonly databaseIdentity: string;
  readonly to: string;
  readonly host?: string;
}) =>
  Effect.gen(function* () {
    const host = yield* normalizeHost(options.host ?? DEFAULT_HOST);
    const args = [
      "rename",
      options.databaseIdentity,
      "--to",
      options.to,
      "--server",
      host,
      "--yes",
    ];
    const env = yield* tokenEnv;
    const result = yield* runSpacetime(args, { env, timeout: "2 minutes" });
    if (result.exitCode !== 0) {
      return yield* new SpacetimeCliError({
        command: args.join(" "),
        ...result,
      });
    }
    return result;
  });

/**
 * `spacetime lock <database>`
 */
export const lockViaCli = (options: {
  readonly database: string;
  readonly host?: string;
}) =>
  Effect.gen(function* () {
    const host = yield* normalizeHost(options.host ?? DEFAULT_HOST);
    const args = ["lock", options.database, "--server", host];
    const env = yield* tokenEnv;
    const result = yield* runSpacetime(args, { env, timeout: "2 minutes" });
    if (result.exitCode !== 0) {
      return yield* new SpacetimeCliError({
        command: args.join(" "),
        ...result,
      });
    }
    return result;
  });

/**
 * `spacetime unlock <database>`
 */
export const unlockViaCli = (options: {
  readonly database: string;
  readonly host?: string;
}) =>
  Effect.gen(function* () {
    const host = yield* normalizeHost(options.host ?? DEFAULT_HOST);
    const args = ["unlock", options.database, "--server", host];
    const env = yield* tokenEnv;
    const result = yield* runSpacetime(args, { env, timeout: "2 minutes" });
    if (result.exitCode !== 0) {
      return yield* new SpacetimeCliError({
        command: args.join(" "),
        ...result,
      });
    }
    return result;
  });

/**
 * Run `spacetime --version` and capture stdout/stderr.
 * @internal Useful for CLI-version pinning diagnostics.
 */
export const spacetimeVersion = (): Effect.Effect<
  { exitCode: ExitCode; stdout: string; stderr: string },
  PlatformError | SpacetimeCliError | SpacetimeCliNotFound,
  ChildProcessSpawner
> => runSpacetime(["--version"], { timeout: "30 seconds" });

const CLI_VERSION_RE = /spacetimedb tool version (\d+\.\d+\.\d+(?:-[\w.]+)?)/;

/**
 * Parse `spacetime --version` output. Returns the semver string or undefined
 * if the output doesn't match the expected format.
 */
export const parseCliVersion = (output: string): string | undefined => {
  const m = output.match(CLI_VERSION_RE);
  return m?.[1];
};
