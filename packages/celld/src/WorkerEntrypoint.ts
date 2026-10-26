import type { DurableObjectId } from "./DurableObjectState.ts";
import {
  fromNativeRpc,
  type Fetcher,
  type NativeFetcher,
  type NativeRpcClient,
} from "./Fetcher.ts";

/** Per-invocation limits validated and enforced by native Celld. */
export interface WorkerInvocationLimits {
  /** Maximum CPU time in milliseconds per invocation; a non-negative uint32. */
  cpuMs?: number;
  /** Maximum subrequests per invocation; a non-negative uint32. */
  subRequests?: number;
}

/** Props-only options for class selectors and ctx.exports loopback selectors. */
export interface WorkerClassOptions {
  /** Structured-clone data delivered as ctx.props, not JSON-serialized. */
  props?: unknown;
}

/** Options for a loaded Worker's getEntrypoint(), not ctx.exports loopbacks. */
export interface WorkerEntrypointOptions extends WorkerClassOptions {
  /**
   * Limits for this entrypoint's fetch and RPC invocations. Native Celld uses
   * the lower value for each limit also specified in WorkerCode.limits.
   */
  limits?: WorkerInvocationLimits;
}

/** A single-method RPC client; no awaitable properties or pipelined paths. */
export type WorkerEntrypoint<Shape = {}> = Fetcher & NativeRpcClient<Shape>;

/** A native loopback entrypoint can be parameterized with structured-clone props. */
export interface NativeWorkerEntrypoint extends NativeFetcher {
  (options: WorkerClassOptions): NativeWorkerEntrypoint;
}

/** The subset of namespace operations implemented by Celld V8. */
export interface NativeDurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  idFromString(value: string): DurableObjectId;
  newUniqueId(): DurableObjectId;
  get(id: DurableObjectId): NativeFetcher;
  getByName(name: string): NativeFetcher;
}

/** Runtime loopback exports, not the complete workerd exports interface. */
export type NativeWorkerExports = Readonly<
  Record<string, NativeWorkerEntrypoint | NativeDurableObjectNamespace>
>;

/** Wrap an explicitly selected native entrypoint; no RPC method discovery. @internal */
export const fromNativeWorkerEntrypoint = <Shape = {}>(
  raw: NativeFetcher,
): WorkerEntrypoint<Shape> => fromNativeRpc<Shape>(raw);
