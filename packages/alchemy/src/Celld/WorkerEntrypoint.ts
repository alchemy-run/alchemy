import type { DurableObjectId } from "./DurableObjectState.ts";
import {
  fromNativeRpc,
  type Fetcher,
  type NativeFetcher,
  type NativeRpcClient,
} from "./Fetcher.ts";

/** Only props is accepted by Celld v0.5 entrypoint/class selectors. */
export interface WorkerEntrypointOptions {
  /** Structured-clone data delivered as ctx.props, not JSON-serialized. */
  props?: unknown;
}

/** A single-method RPC client; no awaitable properties or pipelined paths. */
export type WorkerEntrypoint<Shape = {}> = Fetcher & NativeRpcClient<Shape>;

/** A native loopback entrypoint can be parameterized with structured-clone props. */
export interface NativeWorkerEntrypoint extends NativeFetcher {
  (options: WorkerEntrypointOptions): NativeWorkerEntrypoint;
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
