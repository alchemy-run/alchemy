import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type * as Output from "../Output.ts";

/** A FUSE mount failed to spawn, authenticate, or become ready. */
export class MountError extends Data.TaggedError("FuseMountError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface MountOptions {
  /**
   * Absolute mountpoint inside the host machine. Created if missing.
   * @default /mnt/{bucket.LogicalId}
   */
  readonly path?: string;
  /** Mount only this key prefix of the bucket (`bucket:prefix`). */
  readonly prefix?: string;
  /** Extra flags passed through to the FUSE adapter CLI. */
  readonly args?: ReadonlyArray<string>;
  /**
   * How long to wait for the mount to appear in `/proc/mounts`.
   * @default 30_000
   */
  readonly readyTimeout?: number;
}

/** The result of a successful mount. */
export interface MountHandle {
  /** The absolute path where the bucket's objects are served as files. */
  readonly path: string;
}

/**
 * What a FUSE mount needs from a bucket — deliberately STRUCTURAL, so
 * the contract names no cloud: any bucket resource with an identity
 * and a name fits (`Cloudflare.R2.Bucket` today; `AWS.S3.Bucket` when
 * its implementation lands). The provided {@link Mount} implementation
 * narrows on {@link Type} and dies loudly at plan time when handed a
 * bucket it doesn't implement — pass the bucket to the matching
 * implementation layer.
 */
export interface Bucket {
  /** Resource type discriminant — implementations narrow on this. */
  readonly Type: string;
  readonly LogicalId: string;
  readonly bucketName: Output.Output<string, never>;
}

export interface Mount extends Binding.Service<
  Mount,
  "alchemy/FUSE/Mount",
  (bucket: Bucket, options?: MountOptions) => Effect.Effect<MountHandle>
> {}

/**
 * Mount an object-storage bucket as a FUSE filesystem on the machine
 * this code runs on — files under the mountpoint ARE objects in the
 * bucket, so state written there outlives an ephemeral machine.
 *
 * The contract is cloud-agnostic: the host is anything that provides
 * `Docker.Host` (a Cloudflare Container, AWS MicroVM, ECS Task, …),
 * and the bucket parameter is the structural {@link Bucket} — any
 * bucket resource fits the type, and the PROVIDED implementation layer
 * decides which it actually mounts. Cloud-specific credential wiring
 * lives in those layers — `FUSE.MountTigrisfs` mints a
 * scoped API token, derives R2's S3 credentials from it, and binds
 * them into the host's environment.
 *
 * At runtime the implementation performs the mount and succeeds only
 * once the filesystem is ready. A failed mount DIES (see
 * {@link MountError}) — a machine that cannot mount its persistence is
 * not viable, so the error channel stays `never`.
 *
 * ```ts
 * import * as FUSE from "alchemy/FUSE";
 *
 * // inside a Container's .make() init
 * const persist = yield* FUSE.Mount(Bucket, { path: "/persist" });
 * // ...processes now read/write /persist as ordinary files
 * ```
 * @binding
 * @product FUSE
 * @category Storage & Databases
 */
export const Mount = Binding.Service<Mount>("alchemy/FUSE/Mount");
