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
  NoCheckpoint,
  ExecError,
  ExecResult,
  GrepError,
  GrepRequest,
  GrepResult,
  MountConfig,
} from "./Api.ts";
import type { Disk } from "./Disk.ts";

/**
 * A disk mounted into an exec container, narrowed by chaining:
 *
 * ```typescript
 * logs                          // whole disk, read-write
 * logs.readonly()               // whole disk, writes fail with EROFS
 * logs.subdir("app/2026")       // that subtree exposed as the mount root
 * logs.subdir("app").readonly() // both
 * ```
 */
export interface DiskMount {
  /**
   * Expose only this subtree at the mountpoint, as if it were the disk's
   * root. Relative, no `.`/`..` segments. The command cannot path out of
   * it — pair with {@link readonly} to sandbox untrusted commands.
   */
  subdir(path: string): DiskMount;
  /** Mount read-only — writes fail with `EROFS`. */
  readonly(): DiskMount;
}

/** Anything accepted as a mount: a connection, a raw disk ID, or a {@link DiskMount}. */
export type MountRef = string | DiskConnection | DiskMount;

/**
 * A live connection to one Archil disk: run commands on it, inspect it, and
 * derive new disks from it.
 *
 * Every disk reachable from here is reached *through* a disk you already
 * hold — there is no floating account-scoped handle. Disks created via
 * {@link create} and {@link fork} inherit this connection's region and
 * credentials.
 */
export interface DiskConnection extends DiskMount {
  /** This disk's ID. */
  readonly id: Effect.Effect<string, never, RuntimeContext>;
  /**
   * Run a bash command in an ephemeral container.
   *
   * With no `mounts`, this disk is mounted at `/mnt/archil`:
   * ```typescript
   * yield* data.exec("wc -l /mnt/archil/*.csv");
   * ```
   *
   * With `mounts`, each entry is mounted at `/mnt/archil/<key>` and this
   * disk is *not* implicitly mounted — list it if you want it, so every
   * path in the command is visible in the call:
   * ```typescript
   * yield* data.exec("wc -l /mnt/archil/logs/*.log > /mnt/archil/data/n", {
   *   data,
   *   logs: logs.readonly(),
   * });
   * ```
   *
   * Non-zero exit codes are returned, not raised. All disks must live in
   * this connection's region; activation is atomic (every disk mounts or
   * none do).
   */
  exec(
    command: string,
    mounts?: Record<string, MountRef>,
  ): Effect.Effect<ExecResult, ExecError, RuntimeContext>;
  /** Parallel `grep -E` across this disk, fanned out over containers. */
  grep(
    request: GrepRequest,
  ): Effect.Effect<GrepResult, GrepError, RuntimeContext>;
  /** Read this disk's current state. */
  info(): Effect.Effect<DiskData, DiskNotFound | CommonError, RuntimeContext>;
  /**
   * Delete this disk. Idempotent. Does not delete data in an attached
   * storage mount.
   */
  delete(): Effect.Effect<void, CommonError, RuntimeContext>;
  /** Authorize a user (mount credential) on this disk. */
  addUser(
    user: DiskUserSpec,
  ): Effect.Effect<AuthorizedUser, DiskNotFound | CommonError, RuntimeContext>;
  /** Remove an authorized user from this disk. */
  removeUser(input: {
    type: "token" | "awssts";
    identifier?: string;
  }): Effect.Effect<void, DiskNotFound | CommonError, RuntimeContext>;

  /**
   * Get-or-create a **sibling** disk in this disk's region, and connect to
   * it — the per-user / per-thread workspace call.
   *
   * The new disk is empty; it inherits this connection's region and
   * credentials, not its contents. Use {@link fork} for a copy of the data.
   * Archil's create is idempotent by name, so this serves both first touch
   * and every request after; a name collision with a different
   * configuration fails with the typed `DiskConflict`.
   *
   * Disk names are account-global per region, so include your app/stage in
   * the name. Disks created here are application data, not stack state —
   * deleting them is the application's responsibility.
   */
  create(
    name: string,
    options?: {
      /** Storage backend to sync with. Omit for archil-managed storage. */
      mounts?: MountConfig[];
    },
  ): Effect.Effect<
    CreatedDisk,
    DiskConflict | CommonError | DiskNotFound,
    RuntimeContext
  >;
  /**
   * Fork a **branch** of this disk from one of its checkpoints and connect
   * to it — a copy-on-write clone of the data, unlike {@link create}.
   * Idempotent by name: an existing branch is returned rather than
   * re-forked.
   *
   * Writes on the branch are isolated from this disk and from sibling
   * branches. With no `from`, the newest `committed` checkpoint is used;
   * take checkpoints out-of-band from a mounted disk (`archil checkpoints
   * create`), as the control plane exposes no route for creating them.
   *
   * Branches cannot be deleted — Archil exposes no delete route — so prefer
   * {@link create} for workspaces that need to be reclaimed.
   *
   * A branch is not a security boundary: this disk's credentials cover all
   * of its branches.
   */
  fork(
    name: string,
    options?: {
      /** Checkpoint to fork from. @default the newest committed checkpoint */
      from?: string;
      /** Branch the checkpoint was taken on. Omit for the root branch. */
      fromBranch?: string;
    },
  ): Effect.Effect<
    ForkedDisk,
    DiskNotFound | NoCheckpoint | CommonError,
    RuntimeContext
  >;
  /** List this disk's checkpoints — the snapshots {@link fork} can use. */
  checkpoints(options?: {
    branch?: string;
  }): Effect.Effect<
    CheckpointInfo[],
    DiskNotFound | CommonError,
    RuntimeContext
  >;
  /** List branches forked from this disk. */
  branches(): Effect.Effect<
    BranchInfo[],
    DiskNotFound | CommonError,
    RuntimeContext
  >;
  /**
   * Connect to an already-existing disk by ID, in this disk's region — for
   * IDs that arrive from a request or a database row. No I/O is performed.
   */
  open(diskId: string): DiskConnection;
}

/** A disk provisioned by {@link DiskConnection.create}. */
export interface CreatedDisk {
  /** Connection to the new disk. */
  disk: DiskConnection;
  /** The new disk's ID. */
  diskId: string;
  /**
   * The auto-generated one-time mount token, when Archil returned one
   * (fresh creates only — absent when the create was idempotent).
   */
  diskToken: Redacted.Redacted<string> | undefined;
}

/** A branch created by {@link DiskConnection.fork}. */
export interface ForkedDisk {
  /** Connection addressing the branch's own filesystem. */
  disk: DiskConnection;
  /** The branch as reported by the control plane. */
  branch: BranchInfo;
}

/**
 * Connect to an `Archil.Disk` — a real POSIX filesystem you can run bash
 * against from a Worker, a Durable Object, a Lambda, or a script.
 *
 * The bound disk is the root of everything: run commands on it, search it,
 * and derive per-user or per-thread disks from it with
 * {@link DiskConnection.create} (empty sibling) or
 * {@link DiskConnection.fork} (copy-on-write branch). Derived disks inherit
 * the connection's region and credentials, so there is no account-scoped
 * handle to pass around.
 *
 * Provide {@link ConnectHttp} (mints a dedicated Archil API token per host)
 * or {@link ConnectLocal} (ambient CLI credentials, for scripts and tests).
 * Archil API keys are account-scoped — the platform offers no per-disk or
 * read-only scoping — so a connection narrows the interface, not the
 * credential. For a narrower interface still, bind {@link Exec} or
 * {@link Grep}.
 *
 * @binding
 * @section Connecting
 * @example Bind a disk and run bash on it
 * ```typescript
 * // disks.ts
 * export const DataDisk = Archil.Disk("data");
 *
 * // worker.ts — init
 * const data = yield* Archil.Connect(DataDisk);
 *
 * // request time
 * const { stdout } = yield* data.exec("wc -l /mnt/archil/*.csv");
 * ```
 *
 * @section One Disk per User or Thread
 * @example Derive a workspace per entity
 * `create` is idempotent, so the same call serves first touch and every
 * request after — first touch provisions in milliseconds.
 * ```typescript
 * const { disk } = yield* data.create(`myapp-prod-thread-${threadId}`);
 * yield* disk.exec("cat /mnt/archil/history.md");
 * yield* disk.delete();   // thread closed
 * ```
 *
 * @example Fork a baked base image instead of starting empty
 * Bake and checkpoint the base out-of-band (checkpoints need a mounted
 * disk — a build box or CI step, not a Worker):
 * ```bash
 * sudo archil mount myorg/base /mnt/archil --region aws-us-east-1
 * archil checkpoints create /mnt/archil golden-v1
 * ```
 * ```typescript
 * const { disk } = yield* data.fork(`user-${userId}`, { from: "golden-v1" });
 * yield* disk.exec("python3 /mnt/archil/run.py");
 * ```
 *
 * @section Multiple Disks
 * @example Aggregate across disks in one container
 * ```typescript
 * yield* data.exec(
 *   "wc -l /mnt/archil/logs/*.log > /mnt/archil/data/lines.txt",
 *   { data, logs: logs.readonly() },
 * );
 * ```
 *
 * @example Scope a command to one tenant's subtree
 * The command sees that subtree as its root and cannot path out of it.
 * ```typescript
 * yield* data.exec("ls /mnt/archil/work", {
 *   work: shared.subdir(`tenants/${tenantId}`).readonly(),
 * });
 * ```
 *
 * @see https://docs.archil.com/compute/serverless-execution
 */
export interface Connect extends Binding.Service<
  Connect,
  "Archil.Connect",
  (disk: Disk) => Effect.Effect<DiskConnection>
> {}

export const Connect = Binding.Service<Connect>("Archil.Connect");
