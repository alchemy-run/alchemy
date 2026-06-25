import type {
  HarnessV1NetworkSandboxSession,
  HarnessV1SandboxProvider,
} from "@ai-sdk/harness";
import {
  extractLines,
  type Experimental_SandboxProcess,
  type Experimental_SandboxSession,
} from "@ai-sdk/provider-utils";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

/** Services the local sandbox runs its commands and file I/O against. */
export type LocalSandboxServices = ChildProcessSpawner | FileSystem.FileSystem;

/**
 * Build a `HarnessV1SandboxProvider` that runs the harness directly on the host
 * OS — the container the adapter Layer is deployed in — rather than spinning up
 * a remote micro-VM. Every method is an Effect under the hood (commands go
 * through {@link ChildProcessSpawner}, files through {@link FileSystem}); the
 * captured Effect context is what bridges them to the Promise-shaped AI SDK
 * sandbox contract.
 *
 * Unlike `@ai-sdk/sandbox-just-bash` (in-memory, no ports), this runs real
 * processes against the real filesystem and exposes loopback ports — which is
 * exactly what a bridge-backed harness like OpenCode needs, since the bridge
 * lives in this same container and is reachable on `127.0.0.1`.
 */
export const makeLocalSandbox = Effect.fn(function* (cwd: string) {
  const context = yield* Effect.context<LocalSandboxServices>();
  const fs = yield* FileSystem.FileSystem;

  const runPromise = <A, E>(
    effect: Effect.Effect<A, E, LocalSandboxServices>,
  ): Promise<A> => Effect.runPromise(Effect.provide(effect, context));

  const resolvePath = (p: string) => (p.startsWith("/") ? p : `${cwd}/${p}`);
  const parentDir = (full: string) => {
    const i = full.lastIndexOf("/");
    return i > 0 ? full.slice(0, i) : undefined;
  };

  const readBytes = Effect.fn(function* (path: string) {
    const full = resolvePath(path);
    if (!(yield* fs.exists(full))) return null;
    return yield* fs.readFile(full);
  }, Effect.orDie);

  const readText = Effect.fn(function* (
    path: string,
    startLine?: number,
    endLine?: number,
  ) {
    const full = resolvePath(path);
    if (!(yield* fs.exists(full))) return null;
    const text = yield* fs.readFileString(full);
    return extractLines({ text, startLine, endLine });
  }, Effect.orDie);

  const writeBytes = Effect.fn(function* (path: string, content: Uint8Array) {
    const full = resolvePath(path);
    const parent = parentDir(full);
    if (parent) yield* fs.makeDirectory(parent, { recursive: true });
    yield* fs.writeFile(full, content);
  }, Effect.orDie);

  const writeText = Effect.fn(function* (path: string, content: string) {
    const full = resolvePath(path);
    const parent = parentDir(full);
    if (parent) yield* fs.makeDirectory(parent, { recursive: true });
    yield* fs.writeFileString(full, content);
  }, Effect.orDie);

  const writeStreamContent = (
    path: string,
    content: ReadableStream<Uint8Array>,
  ) =>
    Effect.promise(() => new Response(content).arrayBuffer()).pipe(
      Effect.flatMap((buf) => writeBytes(path, new Uint8Array(buf))),
    );

  interface ProcessOptions {
    readonly command: string;
    readonly workingDirectory?: string;
    readonly env?: Record<string, string>;
  }

  // The harness passes only its own variables (BRIDGE_*, HOME, XDG_*, provider
  // credentials). Node's `env` option *replaces* the environment wholesale, so
  // without merging the host env the child loses `PATH` and can't find `node`
  // or the `opencode` binary — the bridge then exits before becoming ready.
  const baseEnv = yield* Effect.sync(
    () => process.env as Record<string, string | undefined>,
  );
  const resolveEnv = (env: ProcessOptions["env"]) =>
    env === undefined ? undefined : { ...baseEnv, ...env };

  const exec = (options: ProcessOptions) =>
    ChildProcess.make(options.command, {
      shell: true,
      cwd: options.workingDirectory ?? cwd,
      env: resolveEnv(options.env),
    }).pipe(
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
      Effect.map(([exitCode, stdout, stderr]) => ({
        exitCode: Number(exitCode),
        stdout,
        stderr,
      })),
      Effect.scoped,
      Effect.orDie,
    );

  const spawnProcess = Effect.fn(function* (options: ProcessOptions) {
    const scope = yield* Scope.make();
    const handle = yield* ChildProcess.make(options.command, {
      shell: true,
      cwd: options.workingDirectory ?? cwd,
      env: resolveEnv(options.env),
    }).pipe(Effect.provideService(Scope.Scope, scope));

    const process: Experimental_SandboxProcess = {
      pid: handle.pid,
      stdout: Stream.toReadableStream(handle.stdout.pipe(Stream.orDie)),
      stderr: Stream.toReadableStream(handle.stderr.pipe(Stream.orDie)),
      wait: () =>
        runPromise(
          handle.exitCode.pipe(
            Effect.map((exitCode) => ({ exitCode: Number(exitCode) })),
            Effect.ensuring(Scope.close(scope, Exit.void)),
            Effect.orDie,
          ),
        ),
      kill: () =>
        runPromise(
          handle
            .kill()
            .pipe(Effect.andThen(Scope.close(scope, Exit.void)), Effect.orDie),
        ),
    };
    return process;
  });

  const base: Experimental_SandboxSession = {
    description: `Local sandbox running on the host OS via bash. Working directory: ${cwd}`,
    run: (options) => runPromise(exec(options)),
    spawn: (options) => runPromise(spawnProcess(options)),
    readFile: ({ path }) =>
      runPromise(
        readBytes(path).pipe(
          Effect.map((bytes) => (bytes == null ? null : bytesToStream(bytes))),
        ),
      ),
    readBinaryFile: ({ path }) => runPromise(readBytes(path)),
    readTextFile: ({ path, startLine, endLine }) =>
      runPromise(readText(path, startLine, endLine)),
    writeFile: ({ path, content }) =>
      runPromise(writeStreamContent(path, content)),
    writeBinaryFile: ({ path, content }) =>
      runPromise(writeBytes(path, content)),
    writeTextFile: ({ path, content }) => runPromise(writeText(path, content)),
  };

  const makeNetworkSession = (): HarnessV1NetworkSandboxSession => {
    let ports: ReadonlyArray<number> = [];
    return {
      ...base,
      id: crypto.randomUUID(),
      defaultWorkingDirectory: cwd,
      get ports() {
        return ports;
      },
      getPortUrl: ({ port, protocol }) =>
        runPromise(Effect.succeed(`${protocol ?? "http"}://127.0.0.1:${port}`)),
      setPorts: (next) =>
        runPromise(
          Effect.sync(() => {
            ports = [...next];
          }),
        ),
      stop: () => runPromise(Effect.void),
      destroy: () => runPromise(Effect.void),
      restricted: () => base,
    };
  };

  return {
    specificationVersion: "harness-sandbox-v1",
    providerId: "alchemy-local-sandbox",
    createSession: (createOptions) =>
      runPromise(
        Effect.gen(function* () {
          const session = makeNetworkSession();
          if (createOptions?.onFirstCreate) {
            yield* Effect.promise(() =>
              createOptions.onFirstCreate!(session.restricted(), {
                abortSignal: createOptions.abortSignal,
              }),
            );
          }
          return session;
        }),
      ),
  } satisfies HarnessV1SandboxProvider;
});

const bytesToStream = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
