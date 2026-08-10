import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess } from "effect/unstable/process";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { Workspace } from "../Workspace/Workspace.ts";
import {
  Sandbox,
  type SandboxEntry,
  type SandboxExecOptions,
  type SandboxExecResult,
} from "./Sandbox.ts";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETAINED_BYTES = 1_048_576;

/**
 * Quote one shell argument (the Mastra convention for `exec`'s `args`):
 * safe characters pass through, everything else is single-quoted with
 * embedded quotes escaped.
 */
const shellQuote = (arg: string): string =>
  /^[A-Za-z0-9_/:=.,@%^+-]+$/.test(arg)
    ? arg
    : `'${arg.replaceAll("'", `'\\''`)}'`;

const encoder = new TextEncoder();

/**
 * Bounded stream collector that RETAINS THE NEWEST bytes: when the cap
 * is exceeded the oldest output is dropped (the end of a build or test
 * log is where the verdict is) and the drop is reported.
 */
class RetainedOutput {
  private value = "";
  private dropped = false;

  constructor(private readonly maxBytes: number) {}

  add(chunk: string): void {
    this.value += chunk;
    const bytes = encoder.encode(this.value);
    if (bytes.byteLength > this.maxBytes) {
      this.value = new TextDecoder().decode(
        bytes.slice(bytes.byteLength - this.maxBytes),
      );
      this.dropped = true;
    }
  }

  finish(): { readonly text: string; readonly truncated: boolean } {
    return { text: this.value, truncated: this.dropped };
  }
}

/**
 * Build the LOCAL {@link Sandbox} service value: shell execution via
 * `ChildProcess` and file physics via Effect `FileSystem`, all
 * contained under the {@link Workspace} root. Exported separately from
 * the {@link SandboxLocal} Layer so remote sandboxes (the Cloudflare
 * container guest) can run the SAME physics inside their own machine
 * over a fixed workspace.
 */
export const makeSandboxLocal: Effect.Effect<
  Sandbox["Service"],
  never,
  Workspace | FileSystem.FileSystem | Path.Path | ChildProcessSpawner
> = Effect.gen(function* () {
  const workspace = yield* Workspace;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* Effect.context<ChildProcessSpawner>();

  const exec = (
    command: string,
    args?: ReadonlyArray<string>,
    options?: SandboxExecOptions,
  ): Effect.Effect<SandboxExecResult, string> =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* workspace.root;
        const cwd =
          options?.cwd === undefined || options.cwd === "."
            ? root
            : yield* workspace.resolveExisting(options.cwd);
        const full = args?.length
          ? `${command} ${args.map(shellQuote).join(" ")}`
          : command;
        const timeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;
        const maxRetainedBytes =
          options?.maxRetainedBytes ?? DEFAULT_MAX_RETAINED_BYTES;
        const startedAt = yield* Effect.sync(() => Date.now());

        const handle = yield* ChildProcess.make(full, [], {
          cwd,
          shell: true,
          detached: true,
          ...(options?.env ? { env: options.env, extendEnv: true } : {}),
        }).pipe(Effect.mapError((error) => String(error)));
        const terminate = handle
          .kill({ killSignal: "SIGTERM", forceKillAfter: "1 second" })
          .pipe(Effect.catch(() => Effect.void));

        const consume = (stream: Stream.Stream<Uint8Array, unknown>) =>
          Effect.gen(function* () {
            const collector = new RetainedOutput(maxRetainedBytes);
            yield* Stream.runForEach(Stream.decodeText(stream), (chunk) =>
              Effect.sync(() => collector.add(chunk)),
            ).pipe(Effect.mapError((error) => String(error)));
            return collector.finish();
          });

        const running = Effect.all(
          [
            handle.exitCode,
            consume(handle.stdout),
            consume(handle.stderr),
          ] as const,
          { concurrency: 3 },
        ).pipe(
          Effect.map(
            ([exitCode, stdout, stderr]): SandboxExecResult => ({
              success: exitCode === 0,
              exitCode: exitCode as number,
              stdout: stdout.text,
              stderr: stderr.text,
              stdoutTruncated: stdout.truncated,
              stderrTruncated: stderr.truncated,
              durationMs: Date.now() - startedAt,
            }),
          ),
          Effect.mapError((error) => String(error)),
          Effect.onInterrupt(() => terminate),
        );

        return yield* Effect.raceFirst(
          running,
          Effect.sleep(`${timeout} millis`).pipe(
            Effect.andThen(Effect.forkChild(terminate)),
            Effect.andThen(
              Effect.fail(
                `command timed out after ${timeout}ms — retry with a larger timeout if it needs longer`,
              ),
            ),
          ),
        );
      }),
    ).pipe(Effect.provide(environment));

  const readFile = (target: string): Effect.Effect<string, string> =>
    Effect.gen(function* () {
      const full = yield* workspace.resolveExisting(target);
      const info = yield* fs
        .stat(full)
        .pipe(Effect.mapError((error) => String(error)));
      if (info.type !== "File") {
        return yield* Effect.fail(`not a regular file: ${target}`);
      }
      const bytes = yield* fs
        .readFile(full)
        .pipe(Effect.mapError((error) => String(error)));
      if (bytes.includes(0)) {
        return yield* Effect.fail(
          `cannot read binary file: ${target} (NUL byte detected)`,
        );
      }
      return yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        catch: () => `cannot decode ${target} as UTF-8 text`,
      });
    });

  const writeFile = (
    target: string,
    content: string,
  ): Effect.Effect<void, string> =>
    Effect.gen(function* () {
      const full = yield* workspace.resolveForCreate(target);
      const directory = path.dirname(full);
      yield* fs
        .makeDirectory(directory, { recursive: true })
        .pipe(Effect.mapError((error) => String(error)));
      // atomic: write a sibling temp file, then rename over the target
      const temp = yield* fs
        .makeTempFile({ directory, prefix: ".alchemy-sandbox-write-" })
        .pipe(Effect.mapError((error) => String(error)));
      yield* fs.writeFileString(temp, content).pipe(
        Effect.flatMap(() => fs.rename(temp, full)),
        Effect.mapError((error) => String(error)),
        Effect.ensuring(
          fs
            .remove(temp, { force: true })
            .pipe(Effect.catch(() => Effect.void)),
        ),
      );
    });

  const deleteFile = (target: string): Effect.Effect<void, string> =>
    Effect.gen(function* () {
      const full = yield* workspace.resolveExisting(target);
      yield* fs.remove(full).pipe(Effect.mapError((error) => String(error)));
    });

  const mkdir = (target: string): Effect.Effect<void, string> =>
    Effect.gen(function* () {
      const full = yield* workspace.resolveForCreate(target);
      yield* fs
        .makeDirectory(full, { recursive: true })
        .pipe(Effect.mapError((error) => String(error)));
    });

  const listFiles = (
    target?: string,
  ): Effect.Effect<ReadonlyArray<SandboxEntry>, string> =>
    Effect.gen(function* () {
      const relative = target ?? ".";
      const full =
        relative === "."
          ? yield* workspace.root
          : yield* workspace.resolveExisting(relative);
      const info = yield* fs
        .stat(full)
        .pipe(Effect.mapError((error) => String(error)));
      if (info.type !== "Directory") {
        return yield* Effect.fail(`not a directory: ${relative}`);
      }
      const names = yield* fs
        .readDirectory(full)
        .pipe(Effect.mapError((error) => String(error)));
      const entries: SandboxEntry[] = [];
      for (const name of names) {
        const child = yield* fs
          .stat(path.join(full, name))
          .pipe(Effect.mapError((error) => String(error)));
        entries.push({
          name,
          type:
            child.type === "Directory"
              ? "directory"
              : child.type === "File"
                ? "file"
                : "other",
        });
      }
      entries.sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
      );
      return entries;
    });

  const exists = (target: string): Effect.Effect<boolean, string> =>
    Effect.gen(function* () {
      const full = yield* workspace.resolve(target);
      return yield* fs
        .exists(full)
        .pipe(Effect.mapError((error) => String(error)));
    });

  return { exec, readFile, writeFile, deleteFile, mkdir, listFiles, exists };
});

/**
 * The TRUSTED-HOST {@link Sandbox}: physics over the {@link Workspace}
 * containment root on the driver's own machine. NOT an isolation
 * boundary — processes run as the operator with the operator's
 * environment; containment is path discipline, not a security
 * barrier. Pair with `Workspace.fixed` (one desk for every session)
 * or `Workspace.perRun` (per-session `Git.Workspaces` worktrees).
 */
export const SandboxLocal: Layer.Layer<
  Sandbox,
  never,
  Workspace | FileSystem.FileSystem | Path.Path | ChildProcessSpawner
> = Layer.effect(Sandbox, makeSandboxLocal);
