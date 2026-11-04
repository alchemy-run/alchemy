export type Subscriber =
  | Subscriber.Worker
  | Subscriber.DurableObject
  | Subscriber.QueueConsumer
  | Subscriber.Workflow
  | Subscriber.StorageOwner;

export declare namespace Subscriber {
  export interface Worker {
    readonly kind: "worker";
    readonly scriptName: string;
    readonly entrypoint?: string;
    readonly props?: Record<string, unknown>;
  }
  export interface DurableObject {
    readonly kind: "durable-object";
    readonly scriptName: string;
    readonly className: string;
    readonly uniqueKey: string;
  }
  export interface QueueConsumer {
    readonly kind: "queue-consumer";
    readonly queueName: string;
  }
  export interface Workflow {
    readonly kind: "workflow";
    readonly scriptName: string;
    readonly workflowName: string;
  }
  /**
   * The runtime that owns the shared storage simulators for a storage
   * directory (see {@link RegistryEntry.StorageOwner}).
   */
  export interface StorageOwner {
    readonly kind: "storage-owner";
    /** Canonical (real) path of the storage directory. */
    readonly scope: string;
  }
}

export interface RegistryEntry {
  readonly scriptName: string;
  readonly debugPortAddress: string;
  /**
   * Identifies the workerd process behind `debugPortAddress`. A process restarted
   * after a crash reuses the address, so only this tells subscribers to reconnect.
   * Absent in entries written by older runtimes.
   */
  readonly instanceId?: string;
  readonly services: ReadonlyArray<RegistryEntry.Service>;
  /**
   * How long the entry stays valid without a heartbeat. Defaults to
   * {@link DEFAULT_STALE_AFTER_MS}; storage candidates use a short window so
   * a dead owner is replaced quickly.
   */
  readonly staleAfterMs?: number;
}

export declare namespace RegistryEntry {
  export interface Worker {
    readonly kind: "worker";
    readonly fetchService: string;
    readonly rpcService: string;
  }
  export interface DurableObject {
    readonly kind: "durable-object";
    readonly className: string;
    readonly uniqueKey: string;
    readonly service: string;
  }
  export interface QueueConsumer {
    readonly kind: "queue-consumer";
    readonly queueName: string;
    readonly service: string;
  }
  export interface Workflow {
    readonly kind: "workflow";
    readonly workflowName: string;
    readonly service: string;
  }
  /**
   * A runtime that can own the shared storage simulators (D1, R2, KV, ...)
   * for a storage directory. Every runtime that binds shared storage
   * registers one; the oldest live candidate for a scope owns it, and every
   * runtime routes that storage through the owner, so only one process opens
   * the SQLite files (Miniflare's shared storage candidates).
   */
  export interface StorageOwner {
    readonly kind: "storage-owner";
    /** Canonical (real) path of the storage directory. */
    readonly scope: string;
    /**
     * Identifies the runtime across processes, so a registry proxy can tell
     * it is talking to itself and use workerd's in-process debug port.
     */
    readonly ownerId: string;
    /** Registration time (ms since epoch); the oldest candidate wins. */
    readonly created: number;
  }
  export type Service = Worker | DurableObject | QueueConsumer | Workflow | StorageOwner;
}

/** Default staleness window for registry entries (ms). */
export const DEFAULT_STALE_AFTER_MS = 300_000;

/** Staleness window for storage candidates (ms); heartbeats run every fifth of it. */
export const STORAGE_CANDIDATE_STALE_AFTER_MS = 10_000;

/** Registry entry name of a storage candidate. */
export const storageCandidateName = (ownerId: string) => `__storage-candidate__${ownerId}`;

export interface ResolvedTargetMap {
  [key: string]: ResolvedTarget;
}

export type ResolvedTarget<T extends Subscriber = Subscriber> = Extract<
  RegistryEntry.Service,
  { kind: T["kind"] }
> & {
  readonly scriptName: string;
  readonly debugPortAddress: string;
  readonly instanceId?: string;
};

export const resolvedTargetKey = (entry: ResolvedTarget | Subscriber) => {
  switch (entry.kind) {
    case "worker":
      return `worker:${entry.scriptName}` as const;
    case "durable-object":
      return `durable-object:${entry.scriptName}:${entry.className}` as const;
    case "queue-consumer":
      return `queue-consumer:${entry.queueName}` as const;
    case "workflow":
      return `workflow:${entry.scriptName}:${entry.workflowName}` as const;
    case "storage-owner":
      return `storage-owner:${entry.scope}` as const;
  }
};

/**
 * Elect the storage owner for a scope: the oldest candidate, with the entry
 * name breaking ties, so every process independently picks the same one.
 */
export const electStorageOwner = <T extends { readonly scriptName: string }>(
  candidates: ReadonlyArray<readonly [T, RegistryEntry.StorageOwner]>,
): readonly [T, RegistryEntry.StorageOwner] | undefined =>
  [...candidates].sort(
    ([a, aOwner], [b, bOwner]) =>
      aOwner.created - bOwner.created || a.scriptName.localeCompare(b.scriptName),
  )[0];

/**
 * Header carrying the per-instance credential for registry pushes to the
 * registry proxy (Miniflare's `MF-Dev-Registry-Secret`). The credential lives
 * only in the owning process and the proxy's private binding; it is never
 * written to registry files.
 */
export const HEADER_REGISTRY_UPDATE_SECRET = "Alchemy-Runtime-Registry-Update-Secret";

/**
 * A storage simulator service reached through the owner of a storage
 * directory: the props of the registry proxy's `ExternalStorage` entrypoint.
 */
export interface StorageTarget {
  /** Canonical (real) path of the storage directory. */
  readonly scope: string;
  /** Simulator service on the owner, e.g. `d1`. */
  readonly service: string;
  /** Entrypoint of `service`, if not the default. */
  readonly entrypoint?: string;
  /** Designator props passed to `service` as `ctx.props`. */
  readonly props?: Record<string, unknown>;
  /**
   * RPC properties that return RPC targets (e.g. Stream's `videos`). The
   * proxy terminates these with a local target and forwards its methods,
   * since an RPC property cannot cross the debug port as a property path.
   */
  readonly rpcProperties?: ReadonlyArray<string>;
}
