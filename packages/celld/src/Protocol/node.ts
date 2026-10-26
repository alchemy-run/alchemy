/**
 * Schema values for Celld's object-storage and signed-operator contracts.
 * `@distilled.cloud/celld/node` exports their types and the HTTP
 * operations, but not standalone shape schemas; Alchemy decodes and
 * validates the bucket artifacts with these.
 *
 * @internal
 */
import * as S from "@distilled.cloud/core/schema";
import * as T from "@distilled.cloud/core/trait";

export * from "@distilled.cloud/celld/node";

/** An accepted eviction was interrupted by activity, an alarm, or node fencing. The message preserves cancelled: <reason>. */
/** Eviction completion could not be established. The message preserves failed: <reason>; this does not authorize automatic replay. */
/** Eviction was refused before admission. The message preserves refused: <reason> from the node error envelope. */
export interface EvictCellRequest {
  scope: string;
}
export const EvictCellRequest = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    scope: S.String.pipe(T.Label(), T.LabelEncoding({ preserve: ":$" })),
  }).pipe(T.Http({ method: "POST", uri: "/evict/{scope}", code: 200 })),
).annotate({
  identifier: "EvictCellRequest",
}) as any as S.Schema<EvictCellRequest>;

export interface OkResponse {
  ok: boolean;
}
export const OkResponse = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    ok: S.Boolean,
  }),
).annotate({ identifier: "OkResponse" }) as any as S.Schema<OkResponse>;

export interface GetNodeStateRequest {}
export const GetNodeStateRequest = /*@__PURE__*/ S.suspend(() =>
  S.Struct({}).pipe(T.Http({ method: "GET", uri: "/state", code: 200 })),
).annotate({
  identifier: "GetNodeStateRequest",
}) as any as S.Schema<GetNodeStateRequest>;

export type DocumentMap = { [key: string]: unknown | undefined };
export const DocumentMap = /*@__PURE__*/ S.Record(
  S.String,
  S.Unknown,
) as any as S.Schema<DocumentMap>;

export type DocumentList = Array<unknown>;
export const DocumentList = /*@__PURE__*/ S.Array(S.Unknown) as any as S.Schema<DocumentList>;

/** Isolate pool census. heap_bytes and external_bytes sample isolates not held by a turn. */
export interface PoolCensus {
  live: number;
  live_empty: number;
  retiring: number;
  freed: number;
  cells: number;
  requests: number;
  turns: number;
  heap_bytes: number;
  external_bytes: number;
}
export const PoolCensus = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    live: S.Number,
    live_empty: S.Number,
    retiring: S.Number,
    freed: S.Number,
    cells: S.Number,
    requests: S.Number,
    turns: S.Number,
    heap_bytes: S.Number,
    external_bytes: S.Number,
  }),
).annotate({ identifier: "PoolCensus" }) as any as S.Schema<PoolCensus>;

export type PoolCensuses = { [key: string]: PoolCensus | undefined };
export const PoolCensuses = /*@__PURE__*/ S.Record(
  S.String,
  PoolCensus,
) as any as S.Schema<PoolCensuses>;

/** Current or draining deployment isolate pools, keyed by service or Worker script. */
export interface IsolateCensus {
  stateless: PoolCensus;
  services: PoolCensuses;
  cells: PoolCensuses;
}
export const IsolateCensus = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    stateless: PoolCensus,
    services: PoolCensuses,
    cells: PoolCensuses,
  }),
).annotate({ identifier: "IsolateCensus" }) as any as S.Schema<IsolateCensus>;

export interface DeploymentGeneration {
  generation: number;
  version: string;
  isolates: IsolateCensus;
}
export const DeploymentGeneration = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    generation: S.Number,
    version: S.String,
    isolates: IsolateCensus,
  }),
).annotate({
  identifier: "DeploymentGeneration",
}) as any as S.Schema<DeploymentGeneration>;

export type DeploymentGenerations = Array<DeploymentGeneration>;
export const DeploymentGenerations = /*@__PURE__*/ S.Array(
  DeploymentGeneration,
) as any as S.Schema<DeploymentGenerations>;

export type LongMap = { [key: string]: number | undefined };
export const LongMap = /*@__PURE__*/ S.Record(S.String, S.Number) as any as S.Schema<LongMap>;

export interface DeploymentState {
  generation: number;
  version: string;
  prefix: string;
  draining: DeploymentGenerations;
  swapping: number;
  cells: LongMap;
  isolates: IsolateCensus;
}
export const DeploymentState = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    generation: S.Number,
    version: S.String,
    prefix: S.String,
    draining: DeploymentGenerations,
    swapping: S.Number,
    cells: LongMap,
    isolates: IsolateCensus,
  }),
).annotate({
  identifier: "DeploymentState",
}) as any as S.Schema<DeploymentState>;

/** Jemalloc memory counters from the node snapshot, in bytes. */
export interface AllocatorStats {
  allocated_bytes: number;
  active_bytes: number;
  resident_bytes: number;
  mapped_bytes: number;
  retained_bytes: number;
}
export const AllocatorStats = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    allocated_bytes: S.Number,
    active_bytes: S.Number,
    resident_bytes: S.Number,
    mapped_bytes: S.Number,
    retained_bytes: S.Number,
  }),
).annotate({ identifier: "AllocatorStats" }) as any as S.Schema<AllocatorStats>;

/** System allocator memory counters, in bytes. The node reports null when unavailable. */
export interface LibcMallocStats {
  in_use_bytes: number;
  free_bytes: number;
  mmap_bytes: number;
  arena_bytes: number;
}
export const LibcMallocStats = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    in_use_bytes: S.Number,
    free_bytes: S.Number,
    mmap_bytes: S.Number,
    arena_bytes: S.Number,
  }),
).annotate({
  identifier: "LibcMallocStats",
}) as any as S.Schema<LibcMallocStats>;

/** Node snapshot. Census detail is implementation-defined JSON. If the actor has stopped, the server instead returns only error="actor_stopped". */
export interface NodeState {
  activating?: number;
  activation_waiting?: number;
  adopting?: number;
  capacity_waiting?: number;
  evicting?: number;
  handed_off?: number;
  handoff_failed?: number;
  occupied?: number;
  owned_cells?: number;
  publishes?: number;
  quiescing?: number;
  rebalance_failed?: number;
  rebalanced?: number;
  releasing?: number;
  remote_route_refreshes?: number;
  restoring?: number;
  stops?: number;
  cgroup_current_bytes?: number | null;
  cgroup_working_set_bytes?: number | null;
  in_use_bytes?: number;
  rss_bytes?: number;
  ownership?: string;
  phases?: DocumentMap;
  published?: DocumentList;
  residents?: DocumentList;
  node_load?: unknown;
  shedding?: unknown;
  drainPins?: DocumentList;
  deployment?: DeploymentState;
  error?: string;
  allocator?: AllocatorStats | null;
  libc_malloc?: LibcMallocStats | null;
}
export const NodeState = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    activating: S.optional(S.Number),
    activation_waiting: S.optional(S.Number),
    adopting: S.optional(S.Number),
    capacity_waiting: S.optional(S.Number),
    evicting: S.optional(S.Number),
    handed_off: S.optional(S.Number),
    handoff_failed: S.optional(S.Number),
    occupied: S.optional(S.Number),
    owned_cells: S.optional(S.Number),
    publishes: S.optional(S.Number),
    quiescing: S.optional(S.Number),
    rebalance_failed: S.optional(S.Number),
    rebalanced: S.optional(S.Number),
    releasing: S.optional(S.Number),
    remote_route_refreshes: S.optional(S.Number),
    restoring: S.optional(S.Number),
    stops: S.optional(S.Number),
    cgroup_current_bytes: S.optional(S.NullOr(S.Number)),
    cgroup_working_set_bytes: S.optional(S.NullOr(S.Number)),
    in_use_bytes: S.optional(S.Number),
    rss_bytes: S.optional(S.Number),
    ownership: S.optional(S.String),
    phases: S.optional(DocumentMap),
    published: S.optional(DocumentList),
    residents: S.optional(DocumentList),
    node_load: S.optional(S.Unknown),
    shedding: S.optional(S.Unknown),
    drainPins: S.optional(DocumentList),
    deployment: S.optional(DeploymentState),
    error: S.optional(S.String),
    allocator: S.optional(S.NullOr(AllocatorStats)),
    libc_malloc: S.optional(S.NullOr(LibcMallocStats)),
  }),
).annotate({ identifier: "NodeState" }) as any as S.Schema<NodeState>;

export interface PauseRebalancingRequest {}
export const PauseRebalancingRequest = /*@__PURE__*/ S.suspend(() =>
  S.Struct({}).pipe(T.Http({ method: "POST", uri: "/rebalance/pause", code: 200 })),
).annotate({
  identifier: "PauseRebalancingRequest",
}) as any as S.Schema<PauseRebalancingRequest>;

export interface RebalanceResponse {
  rebalance_paused: boolean;
}
export const RebalanceResponse = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    rebalance_paused: S.Boolean,
  }),
).annotate({
  identifier: "RebalanceResponse",
}) as any as S.Schema<RebalanceResponse>;

export interface ReloadDeploymentRequest {}
export const ReloadDeploymentRequest = /*@__PURE__*/ S.suspend(() =>
  S.Struct({}).pipe(T.Http({ method: "POST", uri: "/reload", code: 200 })),
).annotate({
  identifier: "ReloadDeploymentRequest",
}) as any as S.Schema<ReloadDeploymentRequest>;

export interface ReloadResponse {
  ok: boolean;
  outcome: string;
  generation: number;
  version: string;
  prefix?: string;
}
export const ReloadResponse = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    ok: S.Boolean,
    outcome: S.String,
    generation: S.Number,
    version: S.String,
    prefix: S.optional(S.String),
  }),
).annotate({ identifier: "ReloadResponse" }) as any as S.Schema<ReloadResponse>;

export interface ResumeRebalancingRequest {}
export const ResumeRebalancingRequest = /*@__PURE__*/ S.suspend(() =>
  S.Struct({}).pipe(T.Http({ method: "POST", uri: "/rebalance/resume", code: 200 })),
).annotate({
  identifier: "ResumeRebalancingRequest",
}) as any as S.Schema<ResumeRebalancingRequest>;

export interface RouteCellRequest {
  scope: string;
}
export const RouteCellRequest = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    scope: S.String.pipe(T.Label(), T.LabelEncoding({ preserve: ":$" })),
  }).pipe(T.Http({ method: "GET", uri: "/cell/{scope}", code: 200 })),
).annotate({
  identifier: "RouteCellRequest",
}) as any as S.Schema<RouteCellRequest>;

export interface RouteCellResponse {
  route?: string;
  cell?: string;
  node?: string;
  addr?: string;
  epoch?: number;
  peer_protocol?: number;
}
export const RouteCellResponse = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    route: S.optional(S.String),
    cell: S.optional(S.String),
    node: S.optional(S.String),
    addr: S.optional(S.String),
    epoch: S.optional(S.Number),
    peer_protocol: S.optional(S.Number),
  }),
).annotate({
  identifier: "RouteCellResponse",
}) as any as S.Schema<RouteCellResponse>;

export type ShutdownHandoff = "preserve";
export const ShutdownHandoff = S.String;

export interface ShutdownNodeRequest {
  handoff?: ShutdownHandoff | (string & {});
}
export const ShutdownNodeRequest = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    handoff: S.optional(ShutdownHandoff.pipe(T.Query())),
  }).pipe(T.Http({ method: "POST", uri: "/shutdown", code: 200 })),
).annotate({
  identifier: "ShutdownNodeRequest",
}) as any as S.Schema<ShutdownNodeRequest>;

export type StringList = Array<string>;
export const StringList = /*@__PURE__*/ S.Array(S.String) as any as S.Schema<StringList>;

export type ModuleKind = "wasm";
export const ModuleKind = S.String;

export interface ModuleRef {
  name: string;
  bytes: number;
  sha256: string;
  kind?: ModuleKind;
}
export const ModuleRef = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    name: S.String,
    bytes: S.Number,
    sha256: S.String,
    kind: S.optional(ModuleKind),
  }),
).annotate({ identifier: "ModuleRef" }) as any as S.Schema<ModuleRef>;

export type ModuleRefs = Array<ModuleRef>;
export const ModuleRefs = /*@__PURE__*/ S.Array(ModuleRef) as any as S.Schema<ModuleRefs>;

export interface AssetManifestRef {
  index: string;
  sha256: string;
  file_count: number;
  total_bytes: number;
}
export const AssetManifestRef = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    index: S.String,
    sha256: S.String,
    file_count: S.Number,
    total_bytes: S.Number,
  }),
).annotate({
  identifier: "AssetManifestRef",
}) as any as S.Schema<AssetManifestRef>;

export interface QueueConsumerConfig {
  queue: string;
  max_batch_size: number;
  max_batch_timeout: number;
  max_retries: number;
  dead_letter_queue?: string;
  max_concurrency?: number;
  retry_delay?: number;
}
export const QueueConsumerConfig = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    queue: S.String,
    max_batch_size: S.Number,
    max_batch_timeout: S.Number,
    max_retries: S.Number,
    dead_letter_queue: S.optional(S.String),
    max_concurrency: S.optional(S.Number),
    retry_delay: S.optional(S.Number),
  }),
).annotate({
  identifier: "QueueConsumerConfig",
}) as any as S.Schema<QueueConsumerConfig>;

export type QueueConsumerConfigs = Array<QueueConsumerConfig>;
export const QueueConsumerConfigs = /*@__PURE__*/ S.Array(
  QueueConsumerConfig,
) as any as S.Schema<QueueConsumerConfigs>;

export interface ContainerSpec {
  class_name: string;
  image: string;
  instance_type?: string;
  max_instances?: number;
  runtime?: string;
}
export const ContainerSpec = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    class_name: S.String,
    image: S.String,
    instance_type: S.optional(S.String),
    max_instances: S.optional(S.Number),
    runtime: S.optional(S.String),
  }),
).annotate({ identifier: "ContainerSpec" }) as any as S.Schema<ContainerSpec>;

export type ContainerSpecs = Array<ContainerSpec>;
export const ContainerSpecs = /*@__PURE__*/ S.Array(
  ContainerSpec,
) as any as S.Schema<ContainerSpecs>;

/** Deployment manifest stored at deploy/<script>/<version>/manifest.json. This is an object-storage contract, not an HTTP operation. main_module is null for asset-only deployments. */
export interface Manifest {
  schema_version?: number;
  version: string;
  script_name: string;
  do_classes: StringList;
  sqlite_classes: StringList;
  modules: ModuleRefs;
  assets?: AssetManifestRef;
  crons?: StringList;
  queue_consumers?: QueueConsumerConfigs;
  containers?: ContainerSpecs;
  fence_image?: string;
  required_features?: StringList;
  raw_metadata: unknown;
  main_module?: string | null;
}
export const Manifest = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    schema_version: S.optional(S.Number),
    version: S.String,
    script_name: S.String,
    do_classes: StringList,
    sqlite_classes: StringList,
    modules: ModuleRefs,
    assets: S.optional(AssetManifestRef),
    crons: S.optional(StringList),
    queue_consumers: S.optional(QueueConsumerConfigs),
    containers: S.optional(ContainerSpecs),
    fence_image: S.optional(S.String),
    required_features: S.optional(StringList),
    raw_metadata: S.Unknown,
    main_module: S.optional(S.NullOr(S.String)),
  }),
).annotate({ identifier: "Manifest" }) as any as S.Schema<Manifest>;

export interface Rollout {
  percent: number;
}
export const Rollout = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    percent: S.Number,
  }),
).annotate({ identifier: "Rollout" }) as any as S.Schema<Rollout>;

export interface DeployPointer {
  script_name?: string;
  version: string;
  prefix: string;
  rollout: Rollout;
}
export const DeployPointer = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    script_name: S.optional(S.String),
    version: S.String,
    prefix: S.String,
    rollout: Rollout,
  }),
).annotate({ identifier: "DeployPointer" }) as any as S.Schema<DeployPointer>;

export interface AssetEntry {
  sha256: string;
  bytes: number;
  content_type?: string;
}
export const AssetEntry = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    sha256: S.String,
    bytes: S.Number,
    content_type: S.optional(S.String),
  }),
).annotate({ identifier: "AssetEntry" }) as any as S.Schema<AssetEntry>;

export type AssetEntries = { [key: string]: AssetEntry | undefined };
export const AssetEntries = /*@__PURE__*/ S.Record(
  S.String,
  AssetEntry,
) as any as S.Schema<AssetEntries>;

export type RunWorkerFirst = boolean | StringList;
export const RunWorkerFirst = /*@__PURE__*/ S.Union([
  S.Boolean,
  StringList,
]) as any as S.Schema<RunWorkerFirst>;

export interface AssetConfig {
  binding?: string;
  html_handling?: string;
  not_found_handling?: string;
  run_worker_first?: RunWorkerFirst;
  headers?: string;
  redirects?: string;
  compatibility_date?: string;
  compatibility_flags?: StringList;
}
export const AssetConfig = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    binding: S.optional(S.String),
    html_handling: S.optional(S.String),
    not_found_handling: S.optional(S.String),
    run_worker_first: S.optional(RunWorkerFirst),
    headers: S.optional(S.String),
    redirects: S.optional(S.String),
    compatibility_date: S.optional(S.String),
    compatibility_flags: S.optional(StringList),
  }),
).annotate({ identifier: "AssetConfig" }) as any as S.Schema<AssetConfig>;

export interface AssetIndex {
  schema_version: number;
  entries: AssetEntries;
  config: AssetConfig;
}
export const AssetIndex = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    schema_version: S.Number,
    entries: AssetEntries,
    config: AssetConfig,
  }),
).annotate({ identifier: "AssetIndex" }) as any as S.Schema<AssetIndex>;

export interface QueueConsumerDeployment {
  script_name: string;
  version: string;
  prefix: string;
}
export const QueueConsumerDeployment = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    script_name: S.String,
    version: S.String,
    prefix: S.String,
  }),
).annotate({
  identifier: "QueueConsumerDeployment",
}) as any as S.Schema<QueueConsumerDeployment>;

export interface QueueConsumerAttachment {
  schema_version: number;
  queue: string;
  consumer?: QueueConsumerDeployment;
}
export const QueueConsumerAttachment = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    schema_version: S.Number,
    queue: S.String,
    consumer: S.optional(QueueConsumerDeployment),
  }),
).annotate({
  identifier: "QueueConsumerAttachment",
}) as any as S.Schema<QueueConsumerAttachment>;
