import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type * as Sandbox from "./Sandbox.ts";

/**
 * The client half of the sandbox agent: the wire protocol a runtime speaks to
 * a program that serves `alchemy/SandboxAgent`, and the `alchemy/Sandbox`
 * handle built on it.
 *
 * A host bundle imports only this module. The server half
 * (`alchemy/SandboxAgent`) spawns processes and reads files, so it stays in
 * the sandbox's own bundle.
 */

/** Environment variable that carries a sandbox's bearer token and turns its agent on. */
export const SANDBOX_TOKEN_ENV = "ALCHEMY_SANDBOX_TOKEN";

/** Environment variable that carries a sandbox's idle timeout, in milliseconds. */
export const SANDBOX_IDLE_TIMEOUT_ENV = "ALCHEMY_SANDBOX_IDLE_TIMEOUT";

/**
 * The port the agent listens on when it is added to an image that has no
 * program of its own. A program that serves the agent itself answers on the
 * program's port instead.
 */
export const SANDBOX_AGENT_PORT = 2468;

/** Environment variable that carries the port of an agent added to an image. */
export const SANDBOX_PORT_ENV = "ALCHEMY_SANDBOX_PORT";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** No process or terminal has this id. It may have exited long ago. */
export class SandboxProcessNotFound extends Data.TaggedError("SandboxProcessNotFound")<{
  readonly id: string;
  readonly message: string;
}> {}

/** `exec` ran longer than its `timeout` and was killed. */
export class SandboxExecTimedOut extends Data.TaggedError("SandboxExecTimedOut")<{
  readonly timeoutMs: number;
  readonly message: string;
}> {}

/** A file operation failed. `reason` is the system error (`NotFound`, `PermissionDenied`, …). */
export class SandboxFileError extends Data.TaggedError("SandboxFileError")<{
  readonly path: string;
  readonly reason: string;
  readonly message: string;
}> {}

/** The sandbox can't open a terminal. */
export class SandboxPtyUnavailable extends Data.TaggedError("SandboxPtyUnavailable")<{
  readonly message: string;
}> {}

/** The command could not be started, or its output could not be read. */
export class SandboxSpawnError extends Data.TaggedError("SandboxSpawnError")<{
  readonly message: string;
}> {}

/** The agent could not be reached, or answered with something that is not its protocol. */
export class SandboxAgentError extends Data.TaggedError("SandboxAgentError")<{
  readonly method?: string;
  readonly status?: number;
  readonly message: string;
}> {}

/** Every error a sandbox agent call can fail with. */
export type SandboxError =
  | SandboxProcessNotFound
  | SandboxExecTimedOut
  | SandboxFileError
  | SandboxPtyUnavailable
  | SandboxSpawnError
  | SandboxAgentError;

const text = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

const numeric = (value: unknown): number | undefined =>
  typeof value === "number" ? value : undefined;

const describe = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && "message" in value) {
    const message = (value as { readonly message: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return String(value);
};

// Errors cross the wire as `{ _tag, ...fields }`. They are rebuilt by tag, not
// by class name, because a bundler may rename the classes on either side.
const revivers: Record<string, (fields: Record<string, unknown>) => SandboxError> = {
  SandboxProcessNotFound: (fields) =>
    new SandboxProcessNotFound({ id: text(fields.id), message: text(fields.message) }),
  SandboxExecTimedOut: (fields) =>
    new SandboxExecTimedOut({
      timeoutMs: numeric(fields.timeoutMs) ?? 0,
      message: text(fields.message),
    }),
  SandboxFileError: (fields) =>
    new SandboxFileError({
      path: text(fields.path),
      reason: text(fields.reason, "Unknown"),
      message: text(fields.message),
    }),
  SandboxPtyUnavailable: (fields) => new SandboxPtyUnavailable({ message: text(fields.message) }),
  SandboxSpawnError: (fields) => new SandboxSpawnError({ message: text(fields.message) }),
  SandboxAgentError: (fields) =>
    new SandboxAgentError({
      method: typeof fields.method === "string" ? fields.method : undefined,
      status: numeric(fields.status),
      message: text(fields.message),
    }),
};

/**
 * Turns whatever a sandbox agent call failed with into a {@link SandboxError}:
 * an error the agent sent, a failed HTTP call, or an undecodable response.
 */
export const reviveSandboxError = (error: unknown): SandboxError => {
  if (typeof error === "object" && error !== null) {
    const fields = error as Record<string, unknown>;
    const tag = fields._tag;
    if (typeof tag === "string") {
      if (Object.hasOwn(revivers, tag)) return revivers[tag]!(fields);
      // A failure sent inside a stream arrives wrapped.
      if (tag === "RpcRemoteStreamError") return reviveSandboxError(fields.error);
      if (tag === "RpcCallError") {
        const method = text(fields.method);
        return new SandboxAgentError({
          method,
          status: numeric(fields.status),
          message: `Sandbox agent call "${method}" failed: ${describe(fields.cause)}`,
        });
      }
    }
  }
  return new SandboxAgentError({ message: `Sandbox agent call failed: ${describe(error)}` });
};

// ---------------------------------------------------------------------------
// Wire protocol
// ---------------------------------------------------------------------------

/** Encodes bytes for a JSON argument or result. */
export const toBase64 = (bytes: Uint8Array): string => {
  const encode = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
  if (typeof encode === "function") return encode.call(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

/** Decodes bytes from a JSON argument or result. */
export const fromBase64 = (b64: string): Uint8Array => {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
};

const encoder = new TextEncoder();

const toBytes = (data: string | Uint8Array): Uint8Array =>
  typeof data === "string" ? encoder.encode(data) : data;

/** `ExecOptions` as JSON: the timeout in milliseconds and stdin as base64. */
export interface WireExecOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly stdin?: string;
}

/** A piece of process output as JSON. */
export interface WireProcessOutput {
  readonly fd: "stdout" | "stderr";
  readonly b64: string;
}

/** The signals `kill` sends. */
export type WireSignal = "SIGTERM" | "SIGKILL";

/**
 * The methods a sandbox agent serves over alchemy's RPC, next to the
 * program's own. Their names start with `sandbox.` so they never collide with
 * a program's methods. Bytes travel as base64 strings.
 */
export interface SandboxAgentRpc {
  "sandbox.ping": () => Effect.Effect<{ readonly ok: true }, unknown>;
  "sandbox.exec": (
    command: Sandbox.Command,
    options?: WireExecOptions,
  ) => Effect.Effect<Sandbox.ExecResult, unknown>;
  "sandbox.start": (
    command: Sandbox.Command,
    options?: WireExecOptions,
  ) => Effect.Effect<{ readonly id: string }, unknown>;
  "sandbox.output": (
    id: string,
  ) => Effect.Effect<Stream.Stream<WireProcessOutput, unknown>, unknown>;
  "sandbox.write": (id: string, b64: string) => Effect.Effect<void, unknown>;
  "sandbox.kill": (id: string, signal: WireSignal) => Effect.Effect<void, unknown>;
  "sandbox.wait": (id: string) => Effect.Effect<{ readonly exitCode: number }, unknown>;
  "sandbox.files.read": (path: string) => Effect.Effect<string, unknown>;
  "sandbox.files.readText": (path: string) => Effect.Effect<string, unknown>;
  "sandbox.files.write": (path: string, b64: string) => Effect.Effect<void, unknown>;
  "sandbox.files.list": (path: string) => Effect.Effect<ReadonlyArray<Sandbox.FileEntry>, unknown>;
  "sandbox.files.stat": (path: string) => Effect.Effect<Sandbox.FileEntry, unknown>;
  "sandbox.files.remove": (path: string) => Effect.Effect<void, unknown>;
  "sandbox.files.makeDir": (path: string) => Effect.Effect<void, unknown>;
  "sandbox.pty.open": (
    options: Sandbox.PtyOptions,
  ) => Effect.Effect<{ readonly id: string }, unknown>;
  "sandbox.pty.output": (id: string) => Effect.Effect<Stream.Stream<Uint8Array, unknown>, unknown>;
  "sandbox.pty.write": (id: string, b64: string) => Effect.Effect<void, unknown>;
  "sandbox.pty.resize": (id: string, cols: number, rows: number) => Effect.Effect<void, unknown>;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * What every sandbox that runs the agent can do: run a command, stream a
 * process, use files, open a terminal. A provider adds what its platform has
 * for a sandbox (ports, lifecycle).
 */
export interface SandboxAgentClient
  extends
    Sandbox.SandboxExec<SandboxError>,
    Sandbox.SandboxProcesses<SandboxError>,
    Sandbox.SandboxFiles<SandboxError>,
    Sandbox.SandboxPty<SandboxError> {
  /** Re-attaches to a process started earlier, by its id. */
  attach(id: string): Sandbox.Process<SandboxError>;
  /** Succeeds once the agent answers. */
  readonly ping: Effect.Effect<void, SandboxError>;
}

const wireExecOptions = (options: Sandbox.ExecOptions | undefined): WireExecOptions => ({
  cwd: options?.cwd,
  env: options?.env,
  timeoutMs:
    options?.timeout === undefined
      ? undefined
      : Duration.toMillis(Duration.fromInputUnsafe(options.timeout)),
  stdin: options?.stdin === undefined ? undefined : toBase64(toBytes(options.stdin)),
});

/**
 * Builds the sandbox handle from an RPC stub that reaches the agent (see
 * `makeFetchRpcStub` in `alchemy/Rpc`).
 */
export const makeSandboxAgentClient = (stub: SandboxAgentRpc): SandboxAgentClient => {
  const call = <A>(effect: Effect.Effect<A, unknown>): Effect.Effect<A, SandboxError> =>
    Effect.mapError(effect, reviveSandboxError);

  const attach = (id: string): Sandbox.Process<SandboxError> => ({
    id,
    output: stub["sandbox.output"](id).pipe(
      call,
      Stream.unwrap,
      Stream.mapError(reviveSandboxError),
      Stream.map((chunk) => ({ fd: chunk.fd, data: fromBase64(chunk.b64) })),
    ),
    write: (data) => call(stub["sandbox.write"](id, toBase64(toBytes(data)))),
    kill: (signal) => call(stub["sandbox.kill"](id, signal ?? "SIGTERM")),
    wait: call(stub["sandbox.wait"](id)),
  });

  return {
    ping: stub["sandbox.ping"]().pipe(call, Effect.asVoid),
    exec: (command, options) => call(stub["sandbox.exec"](command, wireExecOptions(options))),
    start: (command, options) =>
      Effect.map(call(stub["sandbox.start"](command, wireExecOptions(options))), ({ id }) =>
        attach(id),
      ),
    attach,
    files: {
      read: (path) => Effect.map(call(stub["sandbox.files.read"](path)), fromBase64),
      readText: (path) => call(stub["sandbox.files.readText"](path)),
      write: (path, data) => call(stub["sandbox.files.write"](path, toBase64(toBytes(data)))),
      list: (path) => call(stub["sandbox.files.list"](path)),
      stat: (path) => call(stub["sandbox.files.stat"](path)),
      remove: (path) => call(stub["sandbox.files.remove"](path)),
      makeDir: (path) => call(stub["sandbox.files.makeDir"](path)),
    },
    pty: {
      open: (options) =>
        Effect.map(call(stub["sandbox.pty.open"](options)), ({ id }) => ({
          id,
          output: stub["sandbox.pty.output"](id).pipe(
            call,
            Stream.unwrap,
            Stream.mapError(reviveSandboxError),
          ),
          write: (data: string | Uint8Array) =>
            call(stub["sandbox.pty.write"](id, toBase64(toBytes(data)))),
          resize: (size: { readonly cols: number; readonly rows: number }) =>
            call(stub["sandbox.pty.resize"](id, size.cols, size.rows)),
        })),
    },
  };
};
