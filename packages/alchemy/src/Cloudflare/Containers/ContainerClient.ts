import type * as cf from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import { fromCloudflareFetcher, type Fetcher } from "../Fetcher.ts";
import { DurableObjectState } from "../Workers/DurableObjectState.ts";
import { ContainerError, type ContainerStartupOptions } from "./Container.ts";
import type { ContainerApplication } from "./ContainerApplication.ts";
import { ContainerPlatform, httpSchemePort } from "./ContainerPlatform.ts";

export type ContainerExecOptions = cf.ContainerExecOptions;
export type ContainerExecOutput = cf.ExecOutput;
export type ContainerInfo = cf.ContainerInfo;
export type ContainerSnapshot = cf.ContainerSnapshot;
export type ContainerSnapshotOptions = cf.ContainerSnapshotOptions;

type PreparedImages<ImageName extends string> = string extends ImageName
  ? Readonly<Record<string, string | undefined>>
  : Readonly<Record<ImageName, string>>;

/** A native process, owned by the scope that called {@link ContainerClient.exec}. */
export interface ContainerProcess {
  /** Process ID inside the container. */
  readonly pid: number;
  /** Whether the process has a pseudo-terminal. */
  readonly isPty: boolean;
  /** Piped standard input. Completing the sink closes stdin. */
  readonly stdin: Sink.Sink<void, Uint8Array, never, ContainerError, RuntimeContext> | undefined;
  /** Piped standard output. Consume this or call output(), not both. */
  readonly stdout: Stream.Stream<Uint8Array, ContainerError, RuntimeContext> | undefined;
  /** Standard error, absent when ignored or combined with stdout. */
  readonly stderr: Stream.Stream<Uint8Array, ContainerError, RuntimeContext> | undefined;
  /** Wait for completion. Nonzero exit codes are returned normally. */
  readonly exitCode: Effect.Effect<number, ContainerError, RuntimeContext>;
  /** Collect output once. For large output, consume stdout and stderr concurrently. */
  output(): Effect.Effect<ContainerExecOutput, ContainerError, RuntimeContext>;
  /** Signal this process. Defaults to SIGTERM; child processes are not signaled. */
  kill(signal?: number): Effect.Effect<void, ContainerError, RuntimeContext>;
  /** Resize the process's pseudo-terminal. */
  resize(cols: number, rows: number): Effect.Effect<void, ContainerError, RuntimeContext>;
}

/**
 * Direct Effect access to the Durable Object Container API. Binding does not
 * start the container or create an application RPC proxy.
 */
export interface ContainerClient<ImageName extends string = string> {
  /** Prepared image references. Required names retain their declaration's keys. */
  readonly images: Effect.Effect<PreparedImages<ImageName>, ContainerError, RuntimeContext>;
  /** Whether the process is running; this does not imply port readiness. */
  readonly running: Effect.Effect<boolean, ContainerError, RuntimeContext>;
  /** Start from an image or snapshot. Returns before ports are ready. */
  start(options?: ContainerStartupOptions): Effect.Effect<void, ContainerError, RuntimeContext>;
  /** Running image and labels, or null when stopped. */
  inspect(): Effect.Effect<ContainerInfo | null, ContainerError, RuntimeContext>;
  /**
   * Execute an argument vector without a shell. The container must already
   * be started. Scope closure kills this process with SIGKILL; descendants
   * are not signaled. Supply an explicit shell when shell syntax is needed.
   */
  exec(
    cmd: string[],
    options?: ContainerExecOptions,
  ): Effect.Effect<ContainerProcess, ContainerError, RuntimeContext | Scope.Scope>;
  /**
   * Save the writable root filesystem. Memory and running processes are not
   * captured. Restore by passing the handle to start({ containerSnapshot }).
   */
  snapshotContainer(
    options?: ContainerSnapshotOptions,
  ): Effect.Effect<ContainerSnapshot, ContainerError, RuntimeContext>;
  /** Wait for exit, preserving failures in the Effect error channel. */
  monitor(): Effect.Effect<void, ContainerError, RuntimeContext>;
  /** Stop the container. */
  destroy(error?: unknown): Effect.Effect<void, ContainerError, RuntimeContext>;
  /** Signal the container's main process. */
  signal(signo: number): Effect.Effect<void, ContainerError, RuntimeContext>;
  /** Access a port. Check readiness before sending application requests. */
  getTcpPort(port: number): Effect.Effect<Fetcher, ContainerError, RuntimeContext>;
  /** Set the idle timeout for this Durable Object instance, in milliseconds. */
  setInactivityTimeout(
    durationMs: number | bigint,
  ): Effect.Effect<void, ContainerError, RuntimeContext>;
  /** Intercept matching outbound HTTP requests. Re-register after each start. */
  interceptOutboundHttp(
    addr: string,
    binding: Fetcher,
  ): Effect.Effect<void, ContainerError, RuntimeContext>;
  /** Intercept all outbound HTTP requests. */
  interceptAllOutboundHttp(binding: Fetcher): Effect.Effect<void, ContainerError, RuntimeContext>;
  /** Intercept matching outbound HTTPS requests. */
  interceptOutboundHttps(
    addr: string,
    binding: Fetcher,
  ): Effect.Effect<void, ContainerError, RuntimeContext>;
}

const containerError = (cause: unknown) =>
  new ContainerError({
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

// workers-types and the DOM lib declare the same web stream / AbortSignal
// classes in separate modules, so values crossing between them need a cast.
const toReadable = (
  stream: cf.ReadableStream | null | undefined,
): Stream.Stream<Uint8Array, ContainerError> | undefined => {
  if (!stream) return undefined;
  return Stream.fromReadableStream({
    evaluate: () => stream as unknown as ReadableStream<Uint8Array>,
    onError: containerError,
  });
};

const toWritable = (
  stream: cf.WritableStream | null | undefined,
): Sink.Sink<void, Uint8Array, never, ContainerError> | undefined => {
  if (!stream) return undefined;
  return Sink.fromWritableStream({
    evaluate: () => stream as unknown as WritableStream<Uint8Array>,
    onError: containerError,
  });
};

/** Abort the exec when either the Effect is interrupted or the caller aborts. */
const combineSignals = (
  interrupt: AbortSignal,
  caller: cf.AbortSignal | undefined,
): cf.AbortSignal => {
  const combined = caller
    ? AbortSignal.any([interrupt, caller as unknown as AbortSignal])
    : interrupt;
  return combined as unknown as cf.AbortSignal;
};

const fromProcess = (process: cf.ExecProcess): ContainerProcess => {
  // Once the exit code is observed, the PID may be reused: stop signaling it.
  let exited = false;
  const markExited = Effect.sync(() => {
    exited = true;
  });

  return {
    pid: process.pid,
    isPty: process.isPty,
    stdin: toWritable(process.stdin),
    stdout: toReadable(process.stdout),
    stderr: toReadable(process.stderr),
    exitCode: Effect.tryPromise({
      try: () => process.exitCode,
      catch: containerError,
    }).pipe(Effect.tap(() => markExited)),
    output: () =>
      Effect.tryPromise({
        try: () => process.output(),
        catch: containerError,
      }).pipe(Effect.tap(() => markExited)),
    kill: (signal) =>
      Effect.try({
        try: () => {
          if (!exited) process.kill(signal);
        },
        catch: containerError,
      }),
    resize: (cols, rows) =>
      Effect.try({
        try: () => process.resize(cols, rows),
        catch: containerError,
      }),
  };
};

/**
 * @internal Adapt `ctx.container` to the Effect client. The container is
 * looked up on every call, never at construction: the client is also built
 * while planning a Worker, where no Durable Object state exists.
 */
export const fromContainer = <ImageName extends string = string>(
  getContainer: () => cf.Container | undefined,
): ContainerClient<ImageName> => {
  const attached = (): cf.Container => {
    const container = getContainer();
    if (!container) {
      throw new Error("No container is attached to this Durable Object.");
    }
    return container;
  };

  const call = <A>(f: (container: cf.Container) => A) =>
    Effect.try({ try: () => f(attached()), catch: containerError });

  const callAsync = <A>(f: (container: cf.Container) => Promise<A>) =>
    Effect.tryPromise({ try: () => f(attached()), catch: containerError });

  const startProcess = (cmd: string[], options?: ContainerExecOptions) =>
    Effect.tryPromise({
      try: (interrupt) =>
        attached().exec(cmd, {
          ...options,
          signal: combineSignals(interrupt, options?.signal),
        }),
      catch: containerError,
    }).pipe(Effect.map(fromProcess));

  return {
    // The binding publishes every declared image under its declared name.
    images: call((container) => container.images as PreparedImages<ImageName>),
    running: call((container) => container.running),
    start: (options) => call((container) => container.start(options)),
    inspect: () => callAsync((container) => container.inspect()),
    exec: (cmd, options) =>
      Effect.acquireRelease(
        startProcess(cmd, options),
        // SIGKILL a process that is still running when its scope closes.
        (process) => Effect.ignore(process.kill(9)),
        { interruptible: true },
      ),
    snapshotContainer: (options = {}) =>
      callAsync((container) => container.snapshotContainer(options)),
    monitor: () => callAsync((container) => container.monitor()),
    destroy: (error) => callAsync((container) => container.destroy(error)),
    signal: (signo) => call((container) => container.signal(signo)),
    getTcpPort: (port) =>
      call((container) => fromCloudflareFetcher(httpSchemePort(container.getTcpPort(port)))),
    setInactivityTimeout: (durationMs) =>
      callAsync((container) => container.setInactivityTimeout(durationMs)),
    // workerd forwards intercepted requests over RPC and accepts only a
    // native Fetcher, which every Alchemy Fetcher carries as `raw`.
    interceptOutboundHttp: (addr, binding) =>
      callAsync((container) => container.interceptOutboundHttp(addr, binding.raw)),
    interceptAllOutboundHttp: (binding) =>
      callAsync((container) => container.interceptAllOutboundHttp(binding.raw)),
    interceptOutboundHttps: (addr, binding) =>
      callAsync((container) => container.interceptOutboundHttps(addr, binding.raw)),
  };
};

/**
 * Attach a Container to the current Durable Object and return its native
 * Effect client. Start the container explicitly when a request needs it.
 * This handle is separate from the application's own fetch/RPC methods.
 *
 * ### Starting an Agent Workspace
 * **Example:** Start the managed image and execute a command
 * ```typescript
 * const sandbox = yield* Cloudflare.Containers.bind(Sandbox);
 * return Effect.succeed({
 *   run: Effect.gen(function* () {
 *     if (!(yield* sandbox.running)) {
 *       yield* sandbox.start({
 *         image: "cloudflare/debian-trixie",
 *         entrypoint: ["sleep", "infinity"],
 *         enableInternet: false,
 *       });
 *     }
 *     const process = yield* sandbox.exec(["uname", "-a"]);
 *     return yield* process.output();
 *   }),
 * });
 * ```
 *
 * @binding
 * @product Containers
 * @category Workers & Compute
 */
export const bind = Effect.fn("Cloudflare.Containers.bind")(function* <
  Shape,
  Req,
  ImageName extends string = string,
>(declaration: {
  Application: Effect.Effect<ContainerApplication<Shape>, never, Req>;
  readonly "~alchemy/Container/Images"?: ImageName;
}) {
  yield* ContainerPlatform.bind(declaration.Application);
  const state = yield* DurableObjectState;
  return fromContainer<ImageName>(() => state.container);
});
