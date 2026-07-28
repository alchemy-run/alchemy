import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type {
  AuthorizedUser,
  BranchInfo,
  CheckpointInfo,
  CommonError,
  DiskConflict,
  DiskData,
  DiskNotFound,
  DiskUserSpec,
  ExecError,
  ExecResult,
  GrepError,
  GrepRequest,
  GrepResult,
  MountConfig,
} from "./Api.ts";
import type { Disk } from "./Disk.ts";
import type { ArchilRegion } from "./Region.ts";

export interface ClientOptions {
  /**
   * Control-plane region this client talks to.
   *
   * @default the region the host's minted token was created in (`*Http`) or
   * the credentials' default region (`*Local`)
   */
  region?: ArchilRegion;
}

export interface DiskTargetOptions {
  /**
   * Region the disk lives in, when it differs from the client's region.
   * Accepts a plain value or a deferred accessor (e.g. `yield* disk.region`).
   *
   * When the reference is an {@link Disk} resource its own region is used
   * by default, so this is only needed for disks addressed by raw ID.
   */
  region?: ArchilRegion | Effect.Effect<ArchilRegion>;
}

/**
 * How a disk is addressed by {@link ArchilClient.disk}:
 *
 * - an `Archil.Disk` resource — or an Effect yielding one, so the resource
 *   can be declared at module scope and imported (`archil.disk(BaseDisk)`).
 *   Its ID and region are read through the resource's accessors.
 * - a disk ID string (or an Effect yielding one) for disks that only exist
 *   at request time — a route param, a database row, a prior `createDisk`.
 */
export type DiskTarget<Req = never> =
  | string
  | Disk
  | Effect.Effect<string, never, Req>
  | Effect.Effect<Disk, never, Req>;

/**
 * A cheap handle on one Archil disk — no I/O until a method is called.
 * Obtained from {@link ArchilClient.disk} (existing disks) or
 * {@link ArchilClient.createDisk} (runtime-provisioned disks).
 */
export interface DiskClient {
  /** The disk ID this handle points at. */
  readonly id: Effect.Effect<string, never, RuntimeContext>;
  /** The region this handle operates in. */
  readonly region: Effect.Effect<ArchilRegion, never, RuntimeContext>;
  /**
   * Run a bash command in an ephemeral container with the disk mounted at
   * `/mnt/archil`. Returns stdout, stderr, exit code, and timing — non-zero
   * exit codes are returned, not raised.
   */
  exec(command: string): Effect.Effect<ExecResult, ExecError, RuntimeContext>;
  /**
   * Parallel, read-only `grep -E` over files on the disk, fanned out across
   * ephemeral containers.
   */
  grep(
    request: GrepRequest,
  ): Effect.Effect<GrepResult, GrepError, RuntimeContext>;
  /** Read the disk's current state. */
  get(): Effect.Effect<DiskData, DiskNotFound | CommonError, RuntimeContext>;
  /**
   * Delete the disk. Idempotent — an already-deleted disk is not an error.
   * Deleting a disk does not delete data in an attached storage mount.
   */
  delete(): Effect.Effect<void, CommonError, RuntimeContext>;
  /** Authorize a user (mount credential) on the disk. */
  addUser(
    user: DiskUserSpec,
  ): Effect.Effect<AuthorizedUser, DiskNotFound | CommonError, RuntimeContext>;
  /** Remove an authorized user from the disk. */
  removeUser(input: {
    type: "token" | "awssts";
    identifier?: string;
  }): Effect.Effect<void, DiskNotFound | CommonError, RuntimeContext>;
  /**
   * List the disk's checkpoints — immutable snapshots you can branch from.
   * Pass `branch` to list checkpoints taken on a branch instead of the
   * disk's root branch.
   *
   * Checkpoints are *created* from a mounted disk (`archil checkpoints
   * create <mountpoint> <name>`), not over HTTP — there is no control-plane
   * route for it. Bake them out-of-band (a build box, CI), then branch from
   * them at runtime.
   */
  checkpoints(options?: {
    branch?: string;
  }): Effect.Effect<
    CheckpointInfo[],
    DiskNotFound | CommonError,
    RuntimeContext
  >;
  /** List the disk's branches. */
  branches(): Effect.Effect<
    BranchInfo[],
    DiskNotFound | CommonError,
    RuntimeContext
  >;
  /**
   * Fork a new writable branch from a checkpoint. Writes on the branch are
   * isolated from the parent disk and from sibling branches, so this is the
   * cheap way to hand every user their own copy of a baked base image.
   *
   * The checkpoint must be `committed`. Branches cannot be deleted — Archil
   * exposes no delete route for them today.
   *
   * A branch is not a security boundary: disk credentials cover the disk and
   * all of its branches.
   */
  createBranch(options: {
    /** Name for the new branch — unique within the disk. */
    name: string;
    /** Checkpoint to fork from. */
    fromCheckpoint: string;
    /**
     * Branch the source checkpoint was taken on. Omit to fork from a
     * checkpoint on the disk's root branch.
     */
    fromBranch?: string;
  }): Effect.Effect<BranchInfo, DiskNotFound | CommonError, RuntimeContext>;
}

/** A disk freshly provisioned at runtime via {@link ArchilClient.createDisk}. */
export interface CreatedDisk {
  /** Handle for operating on the new disk. */
  disk: DiskClient;
  /** The new disk's ID. */
  diskId: string;
  /**
   * The auto-generated one-time mount token, when Archil returned one
   * (fresh creates only — absent when the create was idempotent).
   */
  diskToken: Redacted.Redacted<string> | undefined;
}

/**
 * A mount entry for a multi-disk {@link ArchilClient.exec}: a disk ID, a
 * {@link DiskClient} handle, or a spec selecting a subdirectory and/or
 * marking the mount read-only.
 */
export type ExecMount =
  | string
  | DiskClient
  | {
      disk: string | DiskClient;
      /** Subdirectory of the disk to expose (relative, no `.`/`..`). */
      subdirectory?: string;
      /** Mount read-only — writes fail with EROFS. @default false */
      readOnly?: boolean;
    };

export interface ClientExecRequest {
  /**
   * Map of relative path under `/mnt/archil` to the disk mounted there.
   * Paths must be non-empty, non-absolute, and contain no `.`/`..` segments.
   * Activation is atomic: every disk mounts or none do.
   */
  disks: Record<string, ExecMount>;
  /** Shell command executed via `bash -c`. */
  command: string;
}

/**
 * The runtime client returned by {@link Client} — mirrors Archil's own SDK:
 * one authenticated client per host, disks addressed dynamically.
 */
export interface ArchilClient {
  /**
   * Handle a disk — an `Archil.Disk` resource (the usual case; declare it at
   * module scope and import it) or a raw disk ID known only at request time.
   * See {@link DiskTarget}.
   *
   * Resolve resource references in the host's **init** phase, like any other
   * binding: reading a resource's accessors is what registers them on the
   * host. Raw-ID references are pure and may be resolved at request time.
   * No control-plane I/O happens either way.
   */
  disk<Req = never>(
    ref: DiskTarget<Req>,
    options?: DiskTargetOptions,
  ): Effect.Effect<DiskClient, never, Req>;
  /** List disks in the client's region. */
  listDisks(options?: {
    /** Filter by exact name match. */
    name?: string;
    limit?: number;
    cursor?: string;
  }): Effect.Effect<DiskData[], CommonError, RuntimeContext>;
  /**
   * Get-or-create a disk by name — the primary call for per-user /
   * per-thread disks. Archil's create is idempotent: when a disk with this
   * name and configuration already exists its ID is returned as-is;
   * otherwise a new disk is provisioned (milliseconds) and waited on
   * (bounded) until available. A name collision with a *different*
   * configuration fails with the typed `DiskConflict`.
   *
   * Disk names are account-global per region — include your app/stage in
   * runtime-created names (e.g. `myapp-prod-thread-${id}`) so environments
   * don't collide on the same disks. Runtime-created disks are application
   * data, not IaC state: deleting them again is the application's
   * responsibility.
   */
  createDisk(options: {
    /** Disk name (alphanumeric, dashes, underscores; 1-100 chars). */
    name: string;
    /** Storage mounts to sync with. Omit for archil-managed storage. */
    mounts?: MountConfig[];
  }): Effect.Effect<CreatedDisk, DiskConflict | CommonError, RuntimeContext>;
  /** Read a disk's current state by ID. */
  getDisk(
    id: string,
  ): Effect.Effect<DiskData, DiskNotFound | CommonError, RuntimeContext>;
  /** Delete a disk by ID. Idempotent. */
  deleteDisk(id: string): Effect.Effect<void, CommonError, RuntimeContext>;
  /**
   * Run a bash command with multiple disks mounted at
   * `/mnt/archil/<key>`. All disks must live in the client's region.
   */
  exec(
    request: ClientExecRequest,
  ): Effect.Effect<ExecResult, ExecError, RuntimeContext>;
}

/**
 * Account-scoped Archil client for a Function/Worker — manage disks and run
 * bash on them dynamically, mirroring Archil's own SDK (`archil.getDisk`,
 * `disk.exec`). Bind it once per host; address disks at request time by ID,
 * provision scratch disks on the fly, or pin deploy-time `Archil.Disk`
 * resources through their accessors.
 *
 * The runtime calls are plain HTTPS, so the same binding works from
 * Cloudflare Workers, AWS Lambda, and any other Alchemy host. Provide
 * {@link ClientHttp} (mints a dedicated Archil API token per host) or
 * {@link ClientLocal} (ambient CLI credentials, for scripts and Actions).
 *
 * Archil API keys are account-scoped — the platform offers no per-disk or
 * read-only scoping, so every client carries full control-plane access.
 *
 * @binding
 * @section One Disk per User or Thread
 * @example Get-or-create a workspace per chat thread
 * The core Archil pattern: thousands of disks, one per domain entity,
 * materialized lazily by name. `createDisk` is idempotent, so the same call
 * serves first-touch and every request after.
 * ```typescript
 * const archil = yield* Archil.Client();
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     const { disk } = yield* archil.createDisk({
 *       name: `myapp-prod-thread-${threadId}`,
 *     });
 *     const { stdout } = yield* disk.exec("cat /mnt/archil/history.md");
 *     return yield* HttpServerResponse.text(stdout);
 *   }),
 * };
 * ```
 *
 * @example Address an existing disk by ID
 * ```typescript
 * // disk id from the request, a database row, wherever — no I/O
 * const disk = yield* archil.disk(tenantDiskId);
 * const { stdout } = yield* disk.exec("wc -l /mnt/archil/*.csv");
 * ```
 *
 * @example Tear down a per-entity disk
 * ```typescript
 * yield* archil.deleteDisk(diskId);   // or disk.delete() — both idempotent
 * ```
 *
 * @section Deploy-Time Disks
 * @example Pin an `Archil.Disk` resource
 * Declare the disk at module scope and import it — the same shape as any
 * other Alchemy binding (`Cloudflare.R2.ReadBucket(TestBucket)`):
 * ```typescript
 * // disks.ts
 * export const DataDisk = Archil.Disk("data");
 *
 * // worker.ts — init
 * const archil = yield* Archil.Client();
 * const data = yield* archil.disk(DataDisk);
 *
 * // request time
 * const { stdout } = yield* data.exec("ls -la /mnt/archil");
 * ```
 * The disk's own region comes from the resource, so cross-region disks need
 * no extra configuration.
 *
 * @section Base Images (Branches & Checkpoints)
 * @example Fork every user off a baked base image
 * Bake the base disk once and checkpoint it out-of-band (checkpoints require
 * a mounted disk — a build box or CI step, not a Worker):
 *
 * ```bash
 * sudo archil mount myorg/base /mnt/archil --region aws-us-east-1
 * # …install deps, seed data…
 * archil checkpoints create /mnt/archil golden-v1
 * ```
 *
 * Then fork a private writable copy per user at request time. Branch writes
 * are isolated from the base and from every sibling branch:
 * ```typescript
 * // disks.ts
 * export const BaseDisk = Archil.Disk("base");
 *
 * // worker.ts — init
 * const base = yield* archil.disk(BaseDisk);
 *
 * // request time
 * const branch = yield* base.createBranch({
 *   name: `user-${userId}`,
 *   fromCheckpoint: "golden-v1",
 * });
 * ```
 *
 * @example Inspect what you can fork from
 * ```typescript
 * const committed = (yield* base.checkpoints()).filter(
 *   (c) => c.status === "committed",
 * );
 * const existing = yield* base.branches();
 * ```
 *
 * @section Multi-Disk Execution
 * @example Aggregate across disks
 * ```typescript
 * // init
 * const data = yield* archil.disk(DataDisk);
 * const logs = yield* archil.disk(LogsDisk);
 *
 * // request time
 * yield* archil.exec({
 *   disks: {
 *     data,
 *     logs: { disk: logs, readOnly: true },
 *   },
 *   command: "wc -l /mnt/archil/logs/*.log > /mnt/archil/data/lines.txt",
 * });
 * ```
 *
 * @see https://docs.archil.com/compute/serverless-execution
 * @see https://docs.archil.com/sdks/typescript
 */
export interface Client extends Binding.Service<
  Client,
  "Archil.Client",
  (options?: ClientOptions) => Effect.Effect<ArchilClient>
> {}

export const Client = Binding.Service<Client>("Archil.Client");
