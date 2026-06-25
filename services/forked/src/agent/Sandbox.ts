import * as Cloudflare from "alchemy/Cloudflare";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

/** Default command timeout, matching OpenCode's shell tool. */
export const DEFAULT_EXEC_TIMEOUT_MS = 120_000;

/** Where every repository is cloned and where the agent does its work. */
export const WORKSPACE = "/workspace";

/** Result of running a command inside the sandbox. */
export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Options for {@link Sandbox.exec}. */
export interface ExecOptions {
  /** Working directory for the command. @default {@link WORKSPACE} */
  cwd?: string;
  /** Extra environment variables for the command. */
  env?: Record<string, string>;
  /**
   * Timeout in milliseconds. On timeout the command is interrupted and a result
   * with exit code `124` is returned. @default {@link DEFAULT_EXEC_TIMEOUT_MS}
   */
  timeoutMs?: number;
}

/** A single entry returned by {@link Sandbox.list}. */
export interface DirEntry {
  name: string;
  /** `true` when the entry is a directory. */
  directory: boolean;
}

/**
 * The Sandbox — a long-lived Linux container that gives the Coder agent a real
 * machine to work on. It is the substrate every filesystem/process tool runs
 * against: shell commands, repo clones, file reads/writes/edits, and the
 * ripgrep-backed glob/grep tools all execute here.
 *
 * The class only carries the name + typed shape; the runtime (which pulls in
 * the process spawner and Node APIs) lives in `.make()` below and is
 * tree-shaken out of any Durable Object that merely imports the class.
 */
export class Sandbox extends Cloudflare.Container<
  Sandbox,
  {
    /** Run a shell command in the container and capture its output. */
    exec: (command: string, options?: ExecOptions) => Effect.Effect<ExecResult>;
    /** Clone a git repository into `dir` (relative to {@link WORKSPACE}). */
    clone: (
      url: string,
      dir?: string,
    ) => Effect.Effect<ExecResult>;
    /** Read a UTF-8 file. */
    readFile: (path: string) => Effect.Effect<string>;
    /** Whether a path exists and is a directory. */
    isDirectory: (path: string) => Effect.Effect<boolean>;
    /** List a directory's entries (non-recursive), sorted, dirs flagged. */
    list: (path: string) => Effect.Effect<DirEntry[]>;
    /** Create or overwrite a UTF-8 file, making parent directories as needed. */
    writeFile: (path: string, contents: string) => Effect.Effect<void>;
    /** Replace an exact substring in a file; returns how many times it matched. */
    editFile: (
      path: string,
      oldString: string,
      newString: string,
      replaceAll?: boolean,
    ) => Effect.Effect<{ replacements: number }>;
  }
>()("Sandbox") {}

export default Sandbox.make(
  {
    main: import.meta.filename,
    // Debian-based bun image; install the CLI tools the agent leans on.
    dockerfile: `
      FROM oven/bun:1.3
      RUN apt-get update \\
        && apt-get install -y --no-install-recommends git ripgrep ca-certificates curl \\
        && rm -rf /var/lib/apt/lists/*
      WORKDIR ${WORKSPACE}
    `,
  },
  Effect.gen(function* () {
    const cp = yield* ChildProcessSpawner;
    const fs = yield* FileSystem.FileSystem;

    const resolve = (path: string) =>
      path.startsWith("/") ? path : `${WORKSPACE}/${path}`;

    const exec = (command: string, options?: ExecOptions): Effect.Effect<ExecResult> =>
      cp
        .spawn(
          ChildProcess.make(command, {
            shell: true,
            cwd: options?.cwd ? resolve(options.cwd) : WORKSPACE,
            env: options?.env,
          }),
        )
        .pipe(
          Effect.flatMap((handle) =>
            Effect.all(
              [
                handle.exitCode,
                handle.stdout.pipe(Stream.decodeText, Stream.mkString),
                handle.stderr.pipe(Stream.decodeText, Stream.mkString),
              ],
              { concurrency: "unbounded" },
            ),
          ),
          Effect.map(
            ([exitCode, stdout, stderr]): ExecResult => ({
              exitCode,
              stdout,
              stderr,
            }),
          ),
          Effect.scoped,
          Effect.timeoutOption(
            Duration.millis(options?.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS),
          ),
          Effect.map(
            Option.getOrElse(
              (): ExecResult => ({
                exitCode: 124,
                stdout: "",
                stderr: `Command timed out after ${options?.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS}ms`,
              }),
            ),
          ),
          Effect.orDie,
        );

    return Sandbox.of({
      exec,

      clone: (url, dir = ".") =>
        exec(`git clone --depth 1 ${url} ${dir}`),

      readFile: (path) => fs.readFileString(resolve(path)).pipe(Effect.orDie),

      isDirectory: (path) =>
        fs.stat(resolve(path)).pipe(
          Effect.map((info) => info.type === "Directory"),
          Effect.orElseSucceed(() => false),
        ),

      list: (path) =>
        Effect.gen(function* () {
          const full = resolve(path);
          const names = yield* fs.readDirectory(full);
          const entries = yield* Effect.forEach(names, (name) =>
            fs.stat(`${full}/${name}`).pipe(
              Effect.map(
                (info): DirEntry => ({
                  name,
                  directory: info.type === "Directory",
                }),
              ),
              Effect.orElseSucceed((): DirEntry => ({ name, directory: false })),
            ),
          );
          return entries.sort((a, b) => a.name.localeCompare(b.name));
        }).pipe(Effect.orDie),

      writeFile: (path, contents) =>
        Effect.gen(function* () {
          const full = resolve(path);
          const slash = full.lastIndexOf("/");
          if (slash > 0) {
            yield* fs.makeDirectory(full.slice(0, slash), { recursive: true });
          }
          yield* fs.writeFileString(full, contents);
        }).pipe(Effect.orDie),

      editFile: (path, oldString, newString, replaceAll = false) =>
        Effect.gen(function* () {
          const full = resolve(path);
          const current = yield* fs.readFileString(full);
          const occurrences = current.split(oldString).length - 1;
          if (occurrences === 0) {
            return { replacements: 0 };
          }
          const next = replaceAll
            ? current.split(oldString).join(newString)
            : current.replace(oldString, newString);
          yield* fs.writeFileString(full, next);
          return { replacements: replaceAll ? occurrences : 1 };
        }).pipe(Effect.orDie),

      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://sandbox");
        if (url.pathname === "/health") {
          return yield* HttpServerResponse.json({ ok: true });
        }
        return HttpServerResponse.text("forked sandbox");
      }),
    });
  }),
);
