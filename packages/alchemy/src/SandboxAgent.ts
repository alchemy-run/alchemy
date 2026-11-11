import type * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpServer, type HttpEffect } from "./Http.ts";
import { rpcMethodOf, serveRpc } from "./Rpc.ts";
import type * as Sandbox from "./Sandbox.ts";
import {
  fromBase64,
  SANDBOX_AGENT_PORT,
  SANDBOX_IDLE_TIMEOUT_ENV,
  SANDBOX_PORT_ENV,
  SANDBOX_TOKEN_ENV,
  SandboxExecTimedOut,
  SandboxFileError,
  SandboxProcessNotFound,
  SandboxPtyUnavailable,
  SandboxSpawnError,
  toBase64,
  type SandboxAgentRpc,
  type WireExecOptions,
  type WireProcessOutput,
  type WireSignal,
} from "./SandboxAgentClient.ts";

/**
 * The server half of the sandbox agent. A program that serves it answers the
 * `sandbox.*` methods of `alchemy/SandboxAgentClient` next to its own RPC
 * methods: it runs commands, streams processes, reads and writes files and
 * opens terminals inside the machine it runs on.
 *
 * Every RPC call needs the sandbox's bearer token. The program's own `fetch`
 * routes are not gated.
 */

/** How a sandbox agent is started. */
export interface SandboxAgentConfig {
  /** Bearer token every RPC call must carry. */
  readonly token: string;
  /**
   * Exit the process when nothing has called the sandbox for this long, in
   * milliseconds. A request in flight or an attached output stream keeps it
   * alive.
   */
  readonly idleTimeoutMs?: number;
}

// Output a late subscriber still gets: a process that printed and exited
// before anyone attached is not lost.
const HISTORY_BYTES = 1024 * 1024;
// Finished processes and terminals kept for `wait` and `output`.
const FINISHED_KEPT = 256;

interface Replay<A> {
  readonly history: Array<{ readonly item: A; readonly bytes: number }>;
  historyBytes: number;
  readonly subscribers: Set<Queue.Queue<A, Cause.Done>>;
  done: boolean;
}

const makeReplay = <A>(): Replay<A> => ({
  history: [],
  historyBytes: 0,
  subscribers: new Set(),
  done: false,
});

const publish = <A>(replay: Replay<A>, item: A, bytes: number): void => {
  replay.history.push({ item, bytes });
  replay.historyBytes += bytes;
  while (replay.historyBytes > HISTORY_BYTES && replay.history.length > 1) {
    replay.historyBytes -= replay.history.shift()!.bytes;
  }
  for (const queue of replay.subscribers) Queue.offerUnsafe(queue, item);
};

const finish = <A>(replay: Replay<A>): void => {
  replay.done = true;
  for (const queue of replay.subscribers) Queue.endUnsafe(queue);
  replay.subscribers.clear();
};

interface RunningProcess {
  readonly handle: ChildProcessSpawner.ChildProcessHandle;
  readonly stdin: Queue.Queue<Uint8Array, Cause.Done>;
  readonly output: Replay<WireProcessOutput>;
  readonly exit: Deferred.Deferred<{ readonly exitCode: number }, SandboxSpawnError>;
}

interface Terminal {
  write(data: Uint8Array): void;
  resize(cols: number, rows: number): void;
  readonly output: Replay<Uint8Array>;
}

const spawnError = (error: PlatformError.PlatformError) =>
  new SandboxSpawnError({ message: error.message });

const fileType = (type: FileSystem.File.Type): Sandbox.FileEntry["type"] =>
  type === "File"
    ? "file"
    : type === "Directory"
      ? "directory"
      : type === "SymbolicLink"
        ? "symlink"
        : "other";

const toCommand = (
  command: Sandbox.Command,
  options: WireExecOptions | undefined,
  stdin: ChildProcess.CommandInput,
) => {
  const commandOptions = {
    cwd: options?.cwd,
    env: options?.env,
    extendEnv: true,
    stdin,
    stdout: "pipe",
    stderr: "pipe",
  } as const;
  return typeof command === "string"
    ? ChildProcess.make("/bin/sh", ["-c", command], commandOptions)
    : ChildProcess.make(command[0], command.slice(1), commandOptions);
};

/**
 * Builds the agent's RPC methods. Processes and terminals it starts live in
 * one scope that is never closed: they end when they exit or the machine
 * stops.
 */
const makeSandboxAgent = Effect.fn(function* (activity: { streams: number }) {
  const spawner = Option.getOrUndefined(
    yield* Effect.serviceOption(ChildProcessSpawner.ChildProcessSpawner),
  );
  const fs = Option.getOrUndefined(yield* Effect.serviceOption(FileSystem.FileSystem));
  const scope = Scope.makeUnsafe();

  const processes = new Map<string, RunningProcess>();
  const terminals = new Map<string, Terminal>();
  const finishedProcesses: string[] = [];
  const finishedTerminals: string[] = [];
  let nextId = 0;

  const retire = <A>(ids: string[], entries: Map<string, A>, id: string): void => {
    ids.push(id);
    while (ids.length > FINISHED_KEPT) entries.delete(ids.shift()!);
  };

  const noSpawner = new SandboxSpawnError({
    message: "This sandbox's runtime can't start processes.",
  });

  const findProcess = (id: string) => {
    const running = processes.get(id);
    return running === undefined
      ? Effect.fail(new SandboxProcessNotFound({ id, message: `No process "${id}".` }))
      : Effect.succeed(running);
  };

  const findTerminal = (id: string) => {
    const terminal = terminals.get(id);
    return terminal === undefined
      ? Effect.fail(new SandboxProcessNotFound({ id, message: `No terminal "${id}".` }))
      : Effect.succeed(terminal);
  };

  // The replayed history and the live subscription are taken in one
  // synchronous step, so no chunk is lost or repeated between them.
  const subscribe = <A>(replay: Replay<A>): Stream.Stream<A> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<A, Cause.Done>();
        const snapshot = yield* Effect.sync(() => {
          const items = replay.history.map((entry) => entry.item);
          if (replay.done) Queue.endUnsafe(queue);
          else replay.subscribers.add(queue);
          activity.streams++;
          return items;
        });
        return Stream.concat(Stream.fromIterable(snapshot), Stream.fromQueue(queue)).pipe(
          Stream.ensuring(
            Effect.sync(() => {
              replay.subscribers.delete(queue);
              activity.streams--;
            }),
          ),
        );
      }),
    );

  const exec = Effect.fn(function* (command: Sandbox.Command, options?: WireExecOptions) {
    if (spawner === undefined) return yield* noSpawner;
    const stdin: ChildProcess.CommandInput =
      options?.stdin === undefined ? "ignore" : Stream.make(fromBase64(options.stdin));
    const run = Effect.gen(function* () {
      const handle = yield* spawner.spawn(toCommand(command, options, stdin));
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          handle.stdout.pipe(Stream.decodeText, Stream.mkString),
          handle.stderr.pipe(Stream.decodeText, Stream.mkString),
          handle.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      return { exitCode: Number(exitCode), stdout, stderr } satisfies Sandbox.ExecResult;
    }).pipe(Effect.scoped, Effect.mapError(spawnError));
    const timeoutMs = options?.timeoutMs;
    if (timeoutMs === undefined) return yield* run;
    // Closing the command's scope on timeout kills it.
    return yield* run.pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(timeoutMs),
        orElse: () =>
          Effect.fail(
            new SandboxExecTimedOut({
              timeoutMs,
              message: `The command ran longer than ${timeoutMs}ms and was killed.`,
            }),
          ),
      }),
    );
  });

  const start = Effect.fn(function* (command: Sandbox.Command, options?: WireExecOptions) {
    if (spawner === undefined) return yield* noSpawner;
    const id = `p${++nextId}`;
    const stdin = yield* Queue.unbounded<Uint8Array, Cause.Done>();
    if (options?.stdin !== undefined) {
      // Given stdin is written and closed, as `exec` does.
      yield* Queue.offer(stdin, fromBase64(options.stdin));
      yield* Queue.end(stdin);
    }
    const processScope = yield* Scope.fork(scope);
    const handle = yield* spawner.spawn(toCommand(command, options, Stream.fromQueue(stdin))).pipe(
      Scope.provide(processScope),
      Effect.mapError(spawnError),
      Effect.onError(() => Scope.close(processScope, Exit.void)),
    );
    const running: RunningProcess = {
      handle,
      stdin,
      output: makeReplay(),
      exit: yield* Deferred.make<{ readonly exitCode: number }, SandboxSpawnError>(),
    };
    processes.set(id, running);

    const emit = (fd: "stdout" | "stderr") => (data: Uint8Array) =>
      Effect.sync(() => publish(running.output, { fd, b64: toBase64(data) }, data.byteLength));

    yield* Effect.all(
      [
        Stream.runForEach(handle.stdout, emit("stdout")),
        Stream.runForEach(handle.stderr, emit("stderr")),
      ],
      { concurrency: "unbounded", discard: true },
    ).pipe(
      Effect.andThen(handle.exitCode),
      Effect.map((exitCode) => ({ exitCode: Number(exitCode) })),
      Effect.mapError(spawnError),
      Effect.exit,
      Effect.flatMap((exit) =>
        Effect.gen(function* () {
          yield* Effect.sync(() => {
            finish(running.output);
            retire(finishedProcesses, processes, id);
          });
          yield* Queue.end(stdin);
          yield* Deferred.done(running.exit, exit);
          yield* Scope.close(processScope, Exit.void);
        }),
      ),
      Effect.forkIn(scope),
    );
    return { id };
  });

  const fileError = (path: string) => (error: PlatformError.PlatformError) =>
    new SandboxFileError({ path, reason: error.reason._tag, message: error.message });

  const withFiles = <A>(
    path: string,
    use: (fs: FileSystem.FileSystem) => Effect.Effect<A, PlatformError.PlatformError>,
  ): Effect.Effect<A, SandboxFileError> =>
    fs === undefined
      ? Effect.fail(
          new SandboxFileError({
            path,
            reason: "Unavailable",
            message: "This sandbox's runtime has no filesystem access.",
          }),
        )
      : Effect.mapError(use(fs), fileError(path));

  const entryOf = (path: string, info: FileSystem.File.Info): Sandbox.FileEntry => ({
    path,
    type: fileType(info.type),
    size: Number(info.size),
  });

  const openTerminal = Effect.fn(function* (options: Sandbox.PtyOptions) {
    if (typeof Bun === "undefined") {
      return yield* new SandboxPtyUnavailable({
        message: "Terminals need a sandbox whose program runs on Bun.",
      });
    }
    const hasBash =
      fs !== undefined && (yield* fs.exists("/bin/bash").pipe(Effect.orElseSucceed(() => false)));
    const argv =
      options.command !== undefined
        ? ["/bin/sh", "-c", options.command]
        : [hasBash ? "/bin/bash" : "/bin/sh"];
    const id = `t${++nextId}`;
    const output = makeReplay<Uint8Array>();
    const subprocess = yield* Effect.try({
      try: () =>
        Bun.spawn(argv, {
          cwd: options.cwd,
          env: { ...process.env, TERM: "xterm-256color", ...options.env },
          terminal: {
            cols: options.cols,
            rows: options.rows,
            // Bun reuses the buffer it hands over, so keep a copy.
            data: (_terminal, data) => publish(output, data.slice(), data.byteLength),
          },
        }),
      catch: (cause) =>
        new SandboxPtyUnavailable({
          message: `The terminal could not be opened: ${String(cause)}`,
        }),
    });
    terminals.set(id, {
      output,
      write: (data) => {
        subprocess.terminal?.write(data);
      },
      resize: (cols, rows) => {
        subprocess.terminal?.resize(cols, rows);
      },
    });
    yield* Effect.promise(() => subprocess.exited).pipe(
      Effect.andThen(
        Effect.sync(() => {
          finish(output);
          retire(finishedTerminals, terminals, id);
        }),
      ),
      Effect.forkIn(scope),
    );
    return { id };
  });

  // The agent's own failures are typed; `SandboxAgentRpc` describes the
  // client's view, where every failure arrives as `unknown`.
  return {
    "sandbox.ping": () => Effect.succeed({ ok: true as const }),
    "sandbox.exec": exec,
    "sandbox.start": start,
    "sandbox.output": (id: string) =>
      Effect.map(findProcess(id), (running) => subscribe(running.output)),
    "sandbox.write": (id: string, b64: string) =>
      Effect.flatMap(findProcess(id), (running) =>
        Effect.asVoid(Queue.offer(running.stdin, fromBase64(b64))),
      ),
    "sandbox.kill": (id: string, signal: WireSignal) =>
      Effect.flatMap(findProcess(id), (running) =>
        running.output.done
          ? Effect.void
          : Effect.mapError(running.handle.kill({ killSignal: signal }), spawnError),
      ),
    "sandbox.wait": (id: string) =>
      Effect.flatMap(findProcess(id), (running) => Deferred.await(running.exit)),
    "sandbox.files.read": (path: string) =>
      withFiles(path, (fs) => Effect.map(fs.readFile(path), toBase64)),
    "sandbox.files.readText": (path: string) => withFiles(path, (fs) => fs.readFileString(path)),
    "sandbox.files.write": (path: string, b64: string) =>
      withFiles(path, (fs) => {
        const parent = path.slice(0, path.lastIndexOf("/"));
        const write = fs.writeFile(path, fromBase64(b64));
        return parent.length > 0
          ? Effect.andThen(fs.makeDirectory(parent, { recursive: true }), write)
          : write;
      }),
    "sandbox.files.list": (path: string) =>
      withFiles(path, (fs) =>
        Effect.flatMap(fs.readDirectory(path), (names) =>
          Effect.forEach(
            names,
            (name) => {
              const child = path.endsWith("/") ? `${path}${name}` : `${path}/${name}`;
              return fs.stat(child).pipe(
                Effect.map((info) => entryOf(child, info)),
                // A dangling link has no target to describe.
                Effect.orElseSucceed((): Sandbox.FileEntry => ({ path: child, type: "other" })),
              );
            },
            { concurrency: 16 },
          ),
        ),
      ),
    "sandbox.files.stat": (path: string) =>
      withFiles(path, (fs) => Effect.map(fs.stat(path), (info) => entryOf(path, info))),
    "sandbox.files.remove": (path: string) =>
      withFiles(path, (fs) => fs.remove(path, { recursive: true, force: true })),
    "sandbox.files.makeDir": (path: string) =>
      withFiles(path, (fs) => fs.makeDirectory(path, { recursive: true })),
    "sandbox.pty.open": openTerminal,
    "sandbox.pty.output": (id: string) =>
      Effect.map(findTerminal(id), (terminal) => subscribe(terminal.output)),
    "sandbox.pty.write": (id: string, b64: string) =>
      Effect.flatMap(findTerminal(id), (terminal) =>
        Effect.sync(() => terminal.write(fromBase64(b64))),
      ),
    "sandbox.pty.resize": (id: string, cols: number, rows: number) =>
      Effect.flatMap(findTerminal(id), (terminal) =>
        Effect.sync(() => terminal.resize(cols, rows)),
      ),
    scope,
  } satisfies SandboxAgentRpc & { readonly scope: Scope.Scope };
});

const authorized = (header: string | undefined, token: string): boolean => {
  const expected = `Bearer ${token}`;
  if (header === undefined || header.length !== expected.length) return false;
  // Compare every character, so the time taken says nothing about the token.
  let difference = 0;
  for (let i = 0; i < expected.length; i++) {
    difference |= header.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return difference === 0;
};

/**
 * Wraps a program's HTTP handler with the sandbox agent: RPC calls reach the
 * program's own methods (`shape`) and the agent's `sandbox.*` methods, and
 * need the sandbox's bearer token. Everything else goes to `fallback`, the
 * program's `fetch`.
 */
export const serveSandboxAgent = Effect.fn(function* <Req = never>(
  config: SandboxAgentConfig,
  shape: Record<string, unknown>,
  fallback: HttpEffect<Req>,
) {
  const activity = { streams: 0, requests: 0, lastRequest: yield* Clock.currentTimeMillis };
  const { scope, ...agent } = yield* makeSandboxAgent(activity);
  const rpc = serveRpc<Req>({ ...shape, ...agent }, fallback);

  // The program is the container's first process, and the kernel delivers
  // SIGTERM to that process only when it handles the signal. Without a
  // handler a stopped sandbox runs on until the platform kills it, 30 seconds
  // later on ECS. A sandbox keeps nothing a slow shutdown would save.
  yield* Effect.sync(() => {
    process.once("SIGTERM", () => process.exit(143));
  });

  const idleTimeoutMs = config.idleTimeoutMs;
  if (idleTimeoutMs !== undefined && idleTimeoutMs > 0) {
    yield* Clock.currentTimeMillis.pipe(
      Effect.map((now) => {
        const idle =
          activity.requests === 0 &&
          activity.streams === 0 &&
          now - activity.lastRequest >= idleTimeoutMs;
        // Exiting the program stops the machine it is the main process of.
        if (idle) process.exit(0);
      }),
      Effect.repeat(
        Schedule.spaced(Duration.millis(Math.max(1000, Math.min(15_000, idleTimeoutMs / 4)))),
      ),
      Effect.forkIn(scope),
    );
  }

  const handler: HttpEffect<Req> = Effect.gen(function* () {
    const request = yield* HttpServerRequest;
    if (
      rpcMethodOf(request) !== undefined &&
      !authorized(request.headers["authorization"], config.token)
    ) {
      return HttpServerResponse.text("Unauthorized", { status: 401 });
    }
    return yield* rpc;
  });

  const touch = Effect.map(Clock.currentTimeMillis, (now) => {
    activity.lastRequest = now;
  });
  return Effect.suspend(() => {
    activity.requests++;
    return Effect.ensuring(
      Effect.andThen(touch, handler),
      Effect.suspend(() => {
        activity.requests--;
        return touch;
      }),
    );
  }) satisfies HttpEffect<Req>;
});

// The token arrives as a plain per-task environment override, so it is read
// from the process, not through Config.
const sandboxAgentEnv = () => ({
  token: process.env[SANDBOX_TOKEN_ENV],
  idleTimeoutMs: Number(process.env[SANDBOX_IDLE_TIMEOUT_ENV]),
  port: Number(process.env[SANDBOX_PORT_ENV]),
});

/** The agent was started with no sandbox token and no command to run in its place. */
export class SandboxAgentNotStarted extends Data.TaggedError("SandboxAgentNotStarted")<{
  readonly message: string;
}> {}

/**
 * Runs the sandbox agent as a container's first process, for an image that
 * has no program of its own. It serves the `sandbox.*` methods on the port in
 * `ALCHEMY_SANDBOX_PORT`, and starts `command`, when one is given, as a child
 * that shares the container's output.
 *
 * A container started without a sandbox token is not a sandbox: it runs
 * `command` and exits with its code, as the image would without the agent.
 */
export const runSandboxAgent = Effect.fn(function* (command: ReadonlyArray<string>) {
  const env = yield* Effect.sync(sandboxAgentEnv);
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = Effect.gen(function* () {
    const handle = yield* spawner.spawn(
      ChildProcess.make(command[0]!, command.slice(1), {
        extendEnv: true,
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
      }),
    );
    return Number(yield* handle.exitCode);
  }).pipe(Effect.scoped, Effect.mapError(spawnError));

  if (env.token === undefined || env.token === "") {
    if (command.length === 0) {
      return yield* new SandboxAgentNotStarted({
        message: `The sandbox agent starts only for a sandbox (${SANDBOX_TOKEN_ENV} is not set), and neither the image nor the task has a command to run in its place.`,
      });
    }
    const exitCode = yield* child;
    return yield* Effect.sync(() => process.exit(exitCode));
  }

  const handler = yield* serveSandboxAgent(
    {
      token: env.token,
      idleTimeoutMs:
        Number.isFinite(env.idleTimeoutMs) && env.idleTimeoutMs > 0 ? env.idleTimeoutMs : undefined,
    },
    {},
    Effect.succeed(HttpServerResponse.text("Not Found", { status: 404 })),
  );
  const http = yield* HttpServer;
  yield* http.serve(handler, {
    port: Number.isInteger(env.port) && env.port > 0 ? env.port : SANDBOX_AGENT_PORT,
  });
  if (command.length > 0) {
    // The sandbox outlives its command: the host can still run others in it.
    yield* child.pipe(
      Effect.matchEffect({
        onSuccess: (exitCode) => Effect.logInfo(`${command.join(" ")} exited with ${exitCode}`),
        onFailure: (error) =>
          Effect.logError(`${command.join(" ")} did not start: ${error.message}`),
      }),
      Effect.forkScoped,
    );
  }
  return yield* Effect.never;
});
