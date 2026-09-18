import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { Scope } from "effect/Scope";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import {
  fromNativeFetcher,
  type Fetcher,
  type NativeFetcher,
} from "../Fetcher.ts";

/** A native Celld container operation failed. */
export class ContainerError extends Data.TaggedError("Celld.ContainerError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface ContainerStartupOptions {
  /** Command replacing the image CMD; an image ENTRYPOINT remains in effect. */
  entrypoint?: string[];
  /** Environment visible to the process. */
  env?: Record<string, string>;
  /** Allow Internet egress, still fenced from private and host addresses. @default false */
  enableInternet?: boolean;
  /** Engine labels for this run. */
  labels?: Record<string, string>;
}

export interface ContainerExecOptions {
  /** Working directory inside the container. */
  cwd?: string;
  /** User name or uid inside the container. */
  user?: string;
  /** Additional process environment. */
  env?: Record<string, string>;
  /** A request-owned input stream, or a writable pipe. */
  stdin?: ReadableStream<Uint8Array> | "pipe";
  /** Standard output handling. @default "pipe" */
  stdout?: "pipe" | "ignore";
  /** Combining stderr requires piped stdout. @default "pipe" */
  stderr?: "pipe" | "ignore" | "combined";
}

export interface ContainerExecOutput {
  /** Collected standard output bytes. */
  readonly stdout: ArrayBuffer;
  /** Collected standard error bytes. */
  readonly stderr: ArrayBuffer;
  /** Process exit status; a nonzero status does not reject output(). */
  readonly exitCode: number;
}

/** Native process handles belong to the event that called exec(). */
export interface NativeContainerExecProcess {
  readonly pid: number;
  readonly stdin: WritableStream<Uint8Array> | null;
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly stderr: ReadableStream<Uint8Array> | null;
  readonly exitCode: Promise<number>;
  output(): Promise<ContainerExecOutput>;
  kill(signal?: number): void;
}

/** Plain TCP only; container ports reject implicit TLS. */
export interface ContainerConnectOptions {
  /** Keep the write side open when the peer closes its side. */
  allowHalfOpen?: boolean;
  /** Container connections use the private node route. */
  secureTransport?: "off";
}

export type ContainerSocketAddress =
  | string
  | { hostname: string; port: number };

/** Native socket acquired and closed inside one request scope. */
export interface NativeContainerSocket {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  readonly opened: Promise<{ remoteAddress?: string; localAddress?: string }>;
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

export interface NativeContainerPort extends NativeFetcher {
  /** The native port ignores address and always connects to its own container port. */
  connect(
    address: ContainerSocketAddress,
    options?: ContainerConnectOptions,
  ): NativeContainerSocket;
}

export interface ContainerPort extends Fetcher {
  readonly raw: NativeContainerPort;
  /** Acquire a TCP socket and close it with the current event's scope. */
  connect(
    address: ContainerSocketAddress,
    options?: ContainerConnectOptions,
  ): Effect.Effect<
    NativeContainerSocket,
    ContainerError,
    RuntimeContext | Scope
  >;
}

/** Source-derived Celld v0.5 container API, not the wider workerd interface. */
export interface NativeContainer {
  readonly running: boolean;
  start(options?: ContainerStartupOptions): void;
  monitor(): Promise<void>;
  destroy(error?: unknown): Promise<void>;
  signal(signo: number): void;
  getTcpPort(port: number): NativeContainerPort;
  setInactivityTimeout(durationMs: number): Promise<string>;
  exec(
    command: string[],
    options?: ContainerExecOptions,
  ): Promise<NativeContainerExecProcess>;
}

/** A process handle that must not escape the request scope that acquired it. */
export interface ContainerExecProcess {
  readonly pid: number;
  readonly stdin: WritableStream<Uint8Array> | null;
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly stderr: ReadableStream<Uint8Array> | null;
  readonly exitCode: Effect.Effect<number, ContainerError, RuntimeContext>;
  /** Collect once, before consuming either output stream. */
  output(): Effect.Effect<ContainerExecOutput, ContainerError, RuntimeContext>;
  kill(signal?: number): Effect.Effect<void, ContainerError, RuntimeContext>;
}

export interface ContainerClient {
  /** Query the host; no isolate-local running flag is cached. */
  readonly running: Effect.Effect<boolean, ContainerError, RuntimeContext>;
  /** Acknowledgement is not readiness. Failures surface through monitor or port access. */
  start(
    options?: ContainerStartupOptions,
  ): Effect.Effect<void, ContainerError, RuntimeContext>;
  /** Await exit in this event. A nonzero exit fails. */
  monitor(): Effect.Effect<void, ContainerError, RuntimeContext>;
  /** Stop and discard the writable layer. */
  destroy(error?: unknown): Effect.Effect<void, ContainerError, RuntimeContext>;
  signal(signo: number): Effect.Effect<void, ContainerError, RuntimeContext>;
  getTcpPort(
    port: number,
  ): Effect.Effect<ContainerPort, ContainerError, RuntimeContext>;
  setInactivityTimeout(
    durationMs: number,
  ): Effect.Effect<void, ContainerError, RuntimeContext>;
  /**
   * The request scope terminates an uncollected process on exit. Native startup
   * acknowledgement precedes Docker creation; await port readiness before the
   * first exec. A failed exec is never automatically replayed.
   */
  exec(
    command: [string, ...string[]],
    options?: ContainerExecOptions,
  ): Effect.Effect<
    ContainerExecProcess,
    ContainerError,
    RuntimeContext | Scope
  >;
}

const failure = (operation: string) => (cause: unknown) =>
  new ContainerError({ message: `Celld container ${operation} failed`, cause });

/** No I/O or native promises are created until a returned effect runs. @internal */
export const fromNativeContainer = (
  get: () => NativeContainer,
): ContainerClient => ({
  running: Effect.try({ try: () => get().running, catch: failure("running") }),
  start: (options) =>
    Effect.try({ try: () => get().start(options), catch: failure("start") }),
  monitor: () =>
    Effect.tryPromise({
      try: () => get().monitor(),
      catch: failure("monitor"),
    }),
  destroy: (error) =>
    Effect.tryPromise({
      try: () => get().destroy(error),
      catch: failure("destroy"),
    }),
  signal: (signo) =>
    Effect.try({ try: () => get().signal(signo), catch: failure("signal") }),
  getTcpPort: (port) =>
    Effect.try({
      try: () => {
        const native = get().getTcpPort(port);
        return {
          ...fromNativeFetcher(native),
          raw: native,
          connect: (
            address: ContainerSocketAddress,
            options?: ContainerConnectOptions,
          ) =>
            Effect.acquireRelease(
              Effect.try({
                try: () => native.connect(address, options),
                catch: failure("connect"),
              }),
              (socket) =>
                Effect.tryPromise({
                  try: () => socket.close(),
                  catch: failure("socket.close"),
                }).pipe(
                  Effect.catchTag("Celld.ContainerError", Effect.logWarning),
                ),
            ),
        };
      },
      catch: failure("getTcpPort"),
    }),
  setInactivityTimeout: (durationMs) =>
    Effect.tryPromise({
      try: () => get().setInactivityTimeout(durationMs),
      catch: failure("setInactivityTimeout"),
    }).pipe(Effect.asVoid),
  exec: (command, options) =>
    Effect.gen(function* () {
      let collected = false;
      const process = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => get().exec(command, options),
          catch: failure("exec"),
        }),
        (process) =>
          collected
            ? Effect.void
            : Effect.try({
                try: () => process.kill(),
                catch: failure("exec.kill"),
              }).pipe(
                Effect.catchTag("Celld.ContainerError", Effect.logWarning),
              ),
      );
      return {
        pid: process.pid,
        stdin: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr,
        exitCode: Effect.tryPromise({
          try: () => process.exitCode,
          catch: failure("exec.exitCode"),
        }),
        output: () =>
          Effect.tryPromise({
            try: () => process.output(),
            catch: failure("exec.output"),
          }).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                collected = true;
              }),
            ),
          ),
        kill: (signal?: number) =>
          Effect.try({
            try: () => process.kill(signal),
            catch: failure("exec.kill"),
          }),
      };
    }),
});
