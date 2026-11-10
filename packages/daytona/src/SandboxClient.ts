import * as computerUse from "@distilled.cloud/daytona/computer_use";
import type { Credentials } from "@distilled.cloud/daytona/Credentials";
import * as fileSystem from "@distilled.cloud/daytona/file_system";
import * as git from "@distilled.cloud/daytona/git";
import * as info from "@distilled.cloud/daytona/info";
import * as interpreter from "@distilled.cloud/daytona/interpreter";
import * as lsp from "@distilled.cloud/daytona/lsp";
import * as port from "@distilled.cloud/daytona/port";
import * as process from "@distilled.cloud/daytona/process";
import type { DaytonaOpError } from "@distilled.cloud/daytona/Protocol";
import * as sandboxes from "@distilled.cloud/daytona/sandbox";
import * as server from "@distilled.cloud/daytona/server";
import * as system from "@distilled.cloud/daytona/system";
import * as telemetry from "@distilled.cloud/daytona/telemetry";
import * as toolboxStreams from "@distilled.cloud/daytona/Toolbox";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Sandbox from "alchemy/Sandbox";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";
import { pick, scopeModule, type ScopedModule } from "./internal/Scoped.ts";
import { inSandbox } from "./internal/Toolbox.ts";
import { toSeconds } from "./internal/Wait.ts";

/** Operations of the sandbox service that act on one sandbox. */
const SANDBOX_OPERATIONS = [
  "getSandbox",
  "deleteSandbox",
  "startSandbox",
  "stopSandbox",
  "pauseSandbox",
  "archiveSandbox",
  "recoverSandbox",
  "resizeSandbox",
  "replaceLabels",
  "setAutostopInterval",
  "setAutoPauseInterval",
  "setAutoArchiveInterval",
  "setAutoDeleteInterval",
  "setTtl",
  "updateNetworkSettings",
  "updatePublicStatus",
  "updateSandboxSecrets",
  "createSandboxSnapshot",
  "forkSandbox",
  "getSandboxForks",
  "getSandboxParent",
  "getSandboxAncestors",
  "getRegionQuotaBySandboxId",
  "getPortPreviewUrl",
  "getSignedPortPreviewUrl",
  "expireSignedPortPreviewUrl",
  "getBuildLogsUrl",
  "createSshAccess",
  "revokeSshAccess",
  "getSandboxSigningKey",
  "rotateSigningKey",
  "getSandboxLogs",
  "getSandboxTraces",
  "getSandboxTraceSpans",
  "getSandboxMetrics",
] as const;

type SandboxOperations = Pick<typeof sandboxes, (typeof SANDBOX_OPERATIONS)[number]>;

/**
 * Every error a handle's shared calls (`exec`, `start`, `files`, `pty`,
 * `fetch`) can fail with.
 */
export type DaytonaError =
  | DaytonaOpError
  | process.SessionNotFound
  | process.SessionCommandNotFound
  | process.SessionInputNotReady
  | sandboxes.SandboxNotFound
  | toolboxStreams.PtyError
  | toolboxStreams.ToolboxSocketError
  | HttpClientError.HttpClientError;

/**
 * What `exec` returns. Daytona runs a command with stdout and stderr on one
 * stream, so the output is combined in `result`, as Daytona names it.
 */
export interface ExecResult {
  readonly exitCode: number;
  readonly result: string;
}

/**
 * `exec` and `start` options. Daytona's command API takes no stdin, so
 * there is no `stdin` option: `start` a process and `write` to it instead.
 */
export type ExecOptions = Omit<Sandbox.ExecOptions, "stdin">;

/** A command, as a shell line or as an argument vector run without a shell. */
export type Command = Sandbox.Command;

/**
 * A command started with `start`, running in its own Daytona session.
 * Its `id` is the session's; `kill` deletes the session, which ends the
 * command whatever the signal (Daytona takes no signal).
 */
export interface SandboxProcess extends Sandbox.Process<DaytonaError> {
  /** The session the command runs in (also its `id`). */
  readonly sessionId: string;
  /** The command's ID in that session. */
  readonly commandId: string;
}

/** Files in the sandbox, over Daytona's file API; entries are Daytona's `FileInfo`. */
export interface SandboxFiles extends Sandbox.Files<DaytonaError, fileSystem.FileInfo> {
  /** Delete a file, or a directory (and what it holds). */
  remove(path: string): Effect.Effect<void, DaytonaError, RuntimeContext>;
  /** Create a directory and its parents, with `mode` (octal). */
  makeDir(
    path: string,
    options?: { readonly mode?: string },
  ): Effect.Effect<void, DaytonaError, RuntimeContext>;
}

/**
 * `pty.open` options. Daytona starts the user's shell and takes no
 * command, so there is no `command`: type it into the terminal.
 */
export interface PtyOpenOptions {
  /** Session ID. @default a generated one */
  readonly id?: string;
  /** @default 80 */
  readonly cols?: number;
  /** @default 24 */
  readonly rows?: number;
  /** Working directory. */
  readonly cwd?: string;
  /** Environment variables for the shell. */
  readonly env?: Readonly<Record<string, string>>;
}

/** An open terminal, with Daytona's `kill` and `exit` next to the shared calls. */
export interface PtyConnection extends Sandbox.PtyConnection<DaytonaError> {
  /** Kill the terminal's session. */
  readonly kill: Effect.Effect<void, DaytonaError, RuntimeContext>;
  /** Wait for the shell to exit. */
  readonly exit: Effect.Effect<toolboxStreams.PtyExit, DaytonaError, RuntimeContext>;
}

/** Terminals. */
export interface SandboxPty extends Sandbox.Pty<DaytonaError, PtyOpenOptions | undefined> {
  open(
    options?: PtyOpenOptions,
  ): Effect.Effect<PtyConnection, DaytonaError, RuntimeContext | Scope.Scope>;
  /** Connect to a terminal that already runs. */
  connect(
    sessionId: string,
  ): Effect.Effect<PtyConnection, DaytonaError, RuntimeContext | Scope.Scope>;
}

/**
 * Terminals and followed logs: the process calls that stream over a
 * WebSocket.
 */
export interface SandboxProcessStreams {
  /**
   * Create a terminal session and connect to it. The connection closes
   * with the scope; the session keeps running until it exits or is
   * killed.
   */
  createPty(
    request: toolboxStreams.CreatePtyRequest,
  ): Effect.Effect<
    toolboxStreams.PtyConnection,
    toolboxStreams.PtyError,
    RuntimeContext | Scope.Scope
  >;
  /** Connect to an existing terminal session. The connection closes with the scope. */
  connectPty(request: {
    readonly sessionId: string;
  }): Effect.Effect<
    toolboxStreams.PtyConnection,
    toolboxStreams.PtyError,
    RuntimeContext | Scope.Scope
  >;
  /**
   * Follow a session command's output while it runs, as stdout and
   * stderr pieces. The stream ends when the command exits.
   */
  followSessionCommandLogs(request: {
    readonly sessionId: string;
    readonly commandId: string;
  }): Stream.Stream<
    toolboxStreams.LogOutput,
    toolboxStreams.ToolboxSocketOpenError,
    RuntimeContext
  >;
  /** Follow the entrypoint's output. The stream ends when the entrypoint exits. */
  followEntrypointLogs(): Stream.Stream<
    toolboxStreams.LogOutput,
    toolboxStreams.ToolboxSocketOpenError,
    RuntimeContext
  >;
}

/** Code runs in an interpreter context, streamed over a WebSocket. */
export interface SandboxInterpreterRuns {
  /**
   * Run code and wait for it: its stdout, stderr and the exception it
   * raised, if any.
   */
  executeInterpreterCode(
    request: toolboxStreams.InterpreterCodeRequest,
  ): Effect.Effect<
    toolboxStreams.InterpreterResult,
    toolboxStreams.InterpreterCodeError,
    RuntimeContext
  >;
  /** Run code and stream its output as it is produced. */
  streamInterpreterCode(
    request: toolboxStreams.InterpreterCodeRequest,
  ): Stream.Stream<
    toolboxStreams.InterpreterOutput,
    toolboxStreams.InterpreterCodeError,
    RuntimeContext
  >;
}

/** Several files in one request. */
export interface SandboxBulkFiles {
  /** Upload several files. Existing files are overwritten; parent directories are created. */
  uploadFiles(request: {
    readonly files: ReadonlyArray<toolboxStreams.UploadFileEntry>;
  }): Effect.Effect<
    toolboxStreams.UploadFilesResult,
    toolboxStreams.BulkTransferError,
    RuntimeContext
  >;
  /** Download several files. A path that can't be read is reported in `errors`. */
  downloadFiles(request: {
    readonly paths: ReadonlyArray<string>;
  }): Effect.Effect<
    toolboxStreams.DownloadFilesResult,
    toolboxStreams.BulkTransferError,
    RuntimeContext
  >;
}

/**
 * One Daytona sandbox, as a runtime client. Every Daytona operation that
 * acts on a sandbox is a method here, with Daytona's own parameters and
 * typed errors and the sandbox filled in: lifecycle on the handle itself
 * (`startSandbox`, `forkSandbox`, `createSandboxSnapshot`,
 * `getSignedPortPreviewUrl`, …) and the in-sandbox toolbox under
 * `process`, `fs`, `git`, `lsp`, `interpreter`, `computerUse`, `ports`,
 * `info`, `system` and `server`. Telemetry from Daytona's analytics API is
 * under `telemetry`.
 *
 * Every method needs `RuntimeContext`: it runs in a deployed runtime, with
 * the API key its binding minted.
 */
export interface DaytonaSandbox
  extends
    ScopedModule<SandboxOperations>,
    Sandbox.SandboxExec<DaytonaError, ExecResult, ExecOptions>,
    Sandbox.SandboxProcesses<DaytonaError, ExecOptions>,
    Sandbox.SandboxFiles<DaytonaError, fileSystem.FileInfo>,
    Sandbox.SandboxPty<DaytonaError, PtyOpenOptions | undefined>,
    Sandbox.SandboxPorts<DaytonaError, SandboxPort> {
  /** Sandbox ID. */
  readonly sandboxId: string;
  /** Sandbox name. */
  readonly name: string;
  /** The sandbox's toolbox proxy. */
  readonly toolboxProxyUrl: string;
  /** Processes, sessions, terminals and code runs. */
  readonly process: ScopedModule<typeof process> & SandboxProcessStreams;
  /** Files: read, write, list, search, replace, permissions, bulk transfer. */
  readonly fs: ScopedModule<typeof fileSystem> & SandboxBulkFiles;
  /** Git: clone, branch, commit, push, pull, status. */
  readonly git: ScopedModule<typeof git>;
  /** Language servers: start, completions, symbols. */
  readonly lsp: ScopedModule<typeof lsp>;
  /** Stateful code interpreter contexts, and code runs in them. */
  readonly interpreter: ScopedModule<typeof interpreter> & SandboxInterpreterRuns;
  /** Desktop control: screenshots, mouse, keyboard, recordings, accessibility. */
  readonly computerUse: ScopedModule<typeof computerUse>;
  /** Listening ports. */
  readonly ports: ScopedModule<typeof port>;
  /** Home and working directory, daemon version. */
  readonly info: ScopedModule<typeof info>;
  /** System metrics. */
  readonly system: ScopedModule<typeof system>;
  /** Daemon environment. */
  readonly server: ScopedModule<typeof server>;
  /** Logs, traces and metrics the sandbox exported. */
  readonly telemetry: ScopedModule<typeof telemetry>;
  /**
   * Run a command and wait for it. A string runs in a shell (pipes, quotes
   * and `&&` work); an array runs as an argument vector. A non-zero exit
   * is returned, not failed.
   */
  exec(
    command: Command,
    options?: ExecOptions,
  ): Effect.Effect<ExecResult, DaytonaError, RuntimeContext>;
  /**
   * Start a command in its own session and return it while it runs. Closing
   * the scope detaches; the command keeps running until it exits or is killed.
   */
  start(
    command: Command,
    options?: ExecOptions,
  ): Effect.Effect<SandboxProcess, DaytonaError, RuntimeContext | Scope.Scope>;
  /** Files: read, write, list, stat, remove, make directories. */
  readonly files: SandboxFiles;
  /** Terminals. */
  readonly pty: SandboxPty;
  /**
   * A port in the sandbox, reached through its preview URL. `fetch` sends
   * a client request (its URL is a path on the port) or proxies a server
   * request, with the preview token.
   */
  getTcpPort(port: number): Effect.Effect<SandboxPort, DaytonaError, RuntimeContext>;
}

/**
 * A port in a Daytona sandbox, as its preview URL serves it. `fetch` sends
 * the preview token for you; use `url` and `token` to reach it any other
 * way (a browser needs `getSignedPortPreviewUrl` instead).
 */
export interface SandboxPort extends Sandbox.SandboxPort<DaytonaError> {
  /** The port number. */
  readonly port: number;
  /** Preview URL of the port, as Daytona names it. */
  readonly url: string;
  /**
   * Preview token, sent as `X-Daytona-Preview-Token`. A `public` sandbox's
   * previews don't need it.
   */
  readonly token: Redacted.Redacted<string>;
}

/**
 * The handle {@link ConnectSandbox} returns for a sandbox declared at
 * deploy. Its methods are the same as {@link DaytonaSandbox}'s; its
 * identity resolves at runtime, so `sandboxId`, `name` and
 * `toolboxProxyUrl` are Effects.
 */
export interface ConnectedSandbox extends Omit<
  DaytonaSandbox,
  "sandboxId" | "name" | "toolboxProxyUrl"
> {
  /** Sandbox ID. */
  readonly sandboxId: Effect.Effect<string, never, RuntimeContext>;
  /** Sandbox name. */
  readonly name: Effect.Effect<string, never, RuntimeContext>;
  /** The sandbox's toolbox proxy. */
  readonly toolboxProxyUrl: Effect.Effect<string, never, RuntimeContext>;
}

/** What a binding needs to build a handle. */
export interface SandboxIdentity {
  readonly id: string;
  readonly name: string;
  readonly toolboxProxyUrl: string;
}

type Runner = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) => Effect.Effect<A, E, Exclude<R, Credentials | HttpClient.HttpClient> | RuntimeContext>;

/** Everything on a handle but its identity. */
export type SandboxMethods = Omit<DaytonaSandbox, "sandboxId" | "name" | "toolboxProxyUrl">;

/** POSIX single-quote one argument. */
const quote = (arg: string) =>
  /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;

/** A shell line for a command: a string as is, an argument vector quoted. */
const shellLine = (command: Command) =>
  typeof command === "string" ? command : command.map(quote).join(" ");

/** Run a shell line without quoting problems: pass it base64-encoded. */
const viaShell = (line: string) =>
  Effect.sync(() => `sh -c "echo '${Buffer.from(line).toString("base64")}' | base64 -d | sh"`);

/** A fresh session ID, from WebCrypto (every runtime a handle runs on has it). */
const newSessionId = (prefix: string) =>
  Effect.gen(function* () {
    const random = yield* SecureRandom.SecureRandom;
    return `${prefix}-${yield* random.uuidV4()}`;
  }).pipe(Effect.provide(SecureRandom.layerWebCrypto));

/**
 * Build the methods for one sandbox. `identity` resolves the sandbox (at
 * runtime for a sandbox declared at deploy); `run` supplies the binding's
 * credentials, and toolbox calls are additionally scoped to the sandbox.
 */
export const makeSandboxMethods = (
  identity: Effect.Effect<SandboxIdentity, never, RuntimeContext>,
  organizationId: Effect.Effect<string, never, RuntimeContext>,
  run: Runner,
): SandboxMethods => {
  const fixed = Effect.all({ id: identity, organizationId }).pipe(
    Effect.map(({ id, organizationId }) => ({
      sandboxIdOrName: id.id,
      sandboxId: id.id,
      organizationId,
    })),
  );
  const toolbox: Runner = (effect) =>
    Effect.flatMap(identity, (sandbox) =>
      run(inSandbox(sandbox.id, sandbox.toolboxProxyUrl)(effect)),
    );
  // Sockets dial with the runtime's global WebSocket (Workers, Node 22+, Bun, Deno).
  const socket = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    toolbox(Effect.provide(effect, Socket.layerWebSocketConstructorGlobal));
  const stream = <A, E, R>(body: Stream.Stream<A, E, R>) =>
    Effect.context<Credentials | HttpClient.HttpClient | Socket.WebSocketConstructor>().pipe(
      Effect.map((context) => Stream.provideContext(body, context)),
      socket,
      Stream.unwrap,
    );

  const exec = Effect.fn(function* (command: Command, options?: ExecOptions) {
    const response = yield* toolbox(
      process.executeCommand({
        command: yield* viaShell(shellLine(command)),
        cwd: options?.cwd,
        envs: options?.env,
        timeout: toSeconds(options?.timeout),
      }),
    );
    return { exitCode: response.exitCode ?? 0, result: response.result } satisfies ExecResult;
  });

  const start = Effect.fn(function* (command: Command, options?: ExecOptions) {
    const sessionId = yield* newSessionId("alchemy");
    const env = Object.entries(options?.env ?? {})
      .map(([key, value]) => `export ${key}=${quote(value)}`)
      .join("; ");
    const line = [env, options?.cwd ? `cd ${quote(options.cwd)}` : "", `exec ${shellLine(command)}`]
      .filter(Boolean)
      .join("; ");
    yield* toolbox(process.createSession({ sessionId }));
    // Quoted, not piped in: the command's stdin is the session's input.
    const begun = yield* toolbox(
      process.sessionExecuteCommand({
        sessionId,
        command: `sh -c ${quote(line)}`,
        runAsync: true,
        suppressInputEcho: true,
      }),
    );
    const commandId = begun.cmdId;
    const encoder = new TextEncoder();
    return {
      id: sessionId,
      sessionId,
      commandId,
      output: stream(toolboxStreams.followSessionCommandLogs({ sessionId, commandId })).pipe(
        Stream.map((piece) => ({ fd: piece.stream, data: encoder.encode(piece.text) })),
      ),
      write: (data: string | Uint8Array) =>
        toolbox(
          process.sendInput({
            sessionId,
            commandId,
            data: typeof data === "string" ? data : new TextDecoder().decode(data),
          }),
        ).pipe(
          // The daemon creates the command's input pipe just after it starts.
          Effect.retry({
            while: (e) => e._tag === "SessionInputNotReady",
            schedule: Schedule.spaced("250 millis"),
            times: 20,
          }),
          Effect.asVoid,
        ),
      // Daytona takes no signal: deleting the session ends the command.
      kill: () => toolbox(process.deleteSession({ sessionId })).pipe(Effect.asVoid),
      wait: toolbox(process.getSessionCommand({ sessionId, commandId })).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (c) => c.exitCode !== undefined,
        }),
        Effect.map((c) => ({ exitCode: c.exitCode ?? 0 })),
      ),
    } satisfies SandboxProcess;
  });

  const files: SandboxFiles = {
    read: (path) => toolbox(fileSystem.downloadFile({ path })),
    readText: (path) =>
      toolbox(fileSystem.downloadFile({ path })).pipe(
        Effect.map((bytes) => new TextDecoder().decode(bytes)),
      ),
    write: (path, content) =>
      toolbox(fileSystem.uploadFile({ path, body: content })).pipe(Effect.asVoid),
    list: (path) => toolbox(fileSystem.listFiles({ path })),
    stat: (path) => toolbox(fileSystem.getFileInfo({ path })),
    remove: (path) => toolbox(fileSystem.deleteFile({ path, recursive: true })).pipe(Effect.asVoid),
    makeDir: (path, options) =>
      toolbox(fileSystem.createFolder({ path, mode: options?.mode ?? "755" })).pipe(Effect.asVoid),
  };

  /** The shared terminal shape over Daytona's connection. */
  const terminal = (connection: toolboxStreams.PtyConnection): PtyConnection => ({
    id: connection.sessionId,
    output: connection.output,
    write: connection.write,
    resize: ({ cols, rows }) => toolbox(connection.resize(cols, rows)),
    kill: toolbox(connection.kill),
    exit: connection.exit,
  });

  const pty: SandboxPty = {
    open: (options) =>
      Effect.flatMap(options?.id ? Effect.succeed(options.id) : newSessionId("alchemy-pty"), (id) =>
        socket(
          toolboxStreams.createPty({
            id,
            cols: options?.cols,
            rows: options?.rows,
            cwd: options?.cwd,
            envs: options?.env,
          }),
        ).pipe(Effect.map(terminal)),
      ),
    connect: (sessionId) =>
      socket(toolboxStreams.connectPty({ sessionId })).pipe(Effect.map(terminal)),
  };

  const getTcpPort = (port: number) =>
    Effect.flatMap(fixed, ({ sandboxIdOrName }) =>
      run(
        Effect.gen(function* () {
          const preview = yield* sandboxes.getPortPreviewUrl({ sandboxIdOrName, port });
          const client = yield* HttpClient.HttpClient;
          const base = preview.url.replace(/\/$/, "");
          return {
            port,
            url: preview.url,
            token: Redacted.make(preview.token),
            fetch: Sandbox.portFetch<DaytonaError>((request) =>
              Effect.suspend(() => {
                // Only the path and query reach the port: a proxied server
                // request carries its own absolute URL.
                const target = new URL(request.url, "http://port");
                return client.execute(
                  request.pipe(
                    HttpClientRequest.setUrl(`${base}${target.pathname}${target.search}`),
                    HttpClientRequest.setHeader("X-Daytona-Preview-Token", preview.token),
                  ),
                );
              }),
            ),
          } satisfies SandboxPort;
        }),
      ),
    );

  return {
    ...scopeModule(pick(sandboxes, SANDBOX_OPERATIONS), fixed, run),
    process: {
      ...scopeModule(process, {}, toolbox),
      createPty: (request) => socket(toolboxStreams.createPty(request)),
      connectPty: (request) => socket(toolboxStreams.connectPty(request)),
      followSessionCommandLogs: (request) =>
        stream(toolboxStreams.followSessionCommandLogs(request)),
      followEntrypointLogs: () => stream(toolboxStreams.followEntrypointLogs()),
    },
    fs: {
      ...scopeModule(fileSystem, {}, toolbox),
      uploadFiles: (request) => toolbox(toolboxStreams.uploadFiles(request)),
      downloadFiles: (request) => toolbox(toolboxStreams.downloadFiles(request)),
    },
    git: scopeModule(git, {}, toolbox),
    lsp: scopeModule(lsp, {}, toolbox),
    interpreter: {
      ...scopeModule(interpreter, {}, toolbox),
      executeInterpreterCode: (request) => socket(toolboxStreams.executeInterpreterCode(request)),
      streamInterpreterCode: (request) => stream(toolboxStreams.streamInterpreterCode(request)),
    },
    computerUse: scopeModule(computerUse, {}, toolbox),
    ports: scopeModule(port, {}, toolbox),
    info: scopeModule(info, {}, toolbox),
    system: scopeModule(system, {}, toolbox),
    server: scopeModule(server, {}, toolbox),
    telemetry: scopeModule(telemetry, fixed, run),
    exec,
    start,
    files,
    pty,
    getTcpPort,
  };
};

/** The handle for a sandbox whose identity is known (one just created or listed). */
export const makeSandboxClient = (
  sandbox: SandboxIdentity,
  organizationId: Effect.Effect<string, never, RuntimeContext>,
  run: Runner,
): DaytonaSandbox => ({
  ...makeSandboxMethods(Effect.succeed(sandbox), organizationId, run),
  sandboxId: sandbox.id,
  name: sandbox.name,
  toolboxProxyUrl: sandbox.toolboxProxyUrl,
});

/** The handle for a sandbox declared at deploy, whose identity resolves at runtime. */
export const makeConnectedSandbox = (
  identity: Effect.Effect<SandboxIdentity, never, RuntimeContext>,
  organizationId: Effect.Effect<string, never, RuntimeContext>,
  run: Runner,
): ConnectedSandbox => ({
  ...makeSandboxMethods(identity, organizationId, run),
  sandboxId: Effect.map(identity, (s) => s.id),
  name: Effect.map(identity, (s) => s.name),
  toolboxProxyUrl: Effect.map(identity, (s) => s.toolboxProxyUrl),
});
