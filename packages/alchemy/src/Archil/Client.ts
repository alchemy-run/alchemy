import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type {
  AuthorizedUser,
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

export interface DiskRefOptions {
  /**
   * Region the disk lives in, when it differs from the client's region.
   * Accepts a plain value or a deferred accessor (e.g. `yield* disk.region`).
   */
  region?: ArchilRegion | Effect.Effect<ArchilRegion>;
}

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
   * Handle an existing disk by ID — a plain string (known at request time)
   * or a deferred accessor (e.g. `yield* dataDisk.diskId` in the init phase
   * to pin a deploy-time `Archil.Disk` resource). No I/O is performed.
   */
  disk(
    id: string | Effect.Effect<string>,
    options?: DiskRefOptions,
  ): DiskClient;
  /** List disks in the client's region. */
  listDisks(options?: {
    /** Filter by exact name match. */
    name?: string;
    limit?: number;
    cursor?: string;
  }): Effect.Effect<DiskData[], CommonError, RuntimeContext>;
  /**
   * Provision a disk at runtime — idempotent by name — and wait (bounded)
   * for it to become available. Runtime-created disks are application data,
   * not IaC state: deleting them again is the application's responsibility.
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
 * @section Getting a Client
 * @example Bind once, address disks dynamically
 * ```typescript
 * const archil = yield* Archil.Client();
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // disk id from the request, a database row, wherever
 *     const disk = archil.disk(tenantDiskId);
 *     const { stdout } = yield* disk.exec("wc -l /mnt/archil/*.csv");
 *     return yield* HttpServerResponse.text(stdout);
 *   }),
 * };
 * ```
 *
 * @example Pin a deploy-time disk resource
 * ```typescript
 * const dataDisk = yield* Archil.Disk("data");
 * const archil = yield* Archil.Client();
 * const data = archil.disk(yield* dataDisk.diskId);
 *
 * // request time:
 * const { stdout } = yield* data.exec("ls -la /mnt/archil");
 * ```
 *
 * @section Dynamic Provisioning
 * @example Scratch disk per agent session
 * ```typescript
 * const { disk, diskId } = yield* archil.createDisk({
 *   name: `agent-${sessionId}`,
 * });
 * yield* disk.exec("python3 /mnt/archil/job.py");
 * yield* disk.delete();
 * ```
 *
 * @section Multi-Disk Execution
 * @example Aggregate across disks
 * ```typescript
 * yield* archil.exec({
 *   disks: {
 *     data: archil.disk(dataDiskId),
 *     logs: { disk: logsDiskId, readOnly: true },
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
