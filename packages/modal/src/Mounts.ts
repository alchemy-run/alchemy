import type * as sandbox from "@distilled.cloud/modal/sandbox";
import { checkMountSupport, collectMountCapabilities, type MountCapability } from "alchemy/Mount";
import * as Output from "alchemy/Output";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { Ref } from "./Container.ts";

/** A value known at deploy, or an Effect that reads it at runtime. */
type Lazy<T> = T | Effect.Effect<T>;

/** A volume entry's options besides the volume: Modal's own volume mount fields. */
export interface VolumeMountOptions {
  /** Absolute path the volume is mounted at. */
  readonly path: string;
  /** Mount read-only. */
  readonly readOnly?: boolean;
  /** Mount this directory of the volume instead of its root. */
  readonly subPath?: string;
}

/** A bucket entry's options besides the bucket: Modal's own cloud bucket mount fields. */
export interface BucketMountOptions {
  /** Absolute path the bucket is mounted at. */
  readonly path: string;
  /**
   * The bucket's storage API.
   * @default "r2" for a Cloudflare R2 bucket, "s3" otherwise
   */
  readonly type?: "s3" | "r2" | "gcp";
  /**
   * S3-compatible endpoint.
   * @default the account endpoint, for a Cloudflare R2 bucket
   */
  readonly endpointUrl?: string;
  /** Mount only keys under this prefix. */
  readonly keyPrefix?: string;
  /** Mount read-only. */
  readonly readOnly?: boolean;
  /** Assume this AWS role with Modal's OIDC identity instead of a secret. */
  readonly oidcAuthRoleArn?: string;
}

/** The fields of a bucket resource a mount reads: AWS S3, Cloudflare R2, GCS. */
export interface BucketLike {
  readonly bucketName: string;
  /** Cloudflare R2: the account the bucket's endpoint is under. */
  readonly accountId?: string;
  /** Cloudflare R2: `"eu"` or `"fedramp"` buckets have their own endpoint. */
  readonly jurisdiction?: string;
}

/**
 * A `Modal.Volume` mounted at `path`. In Stack props the volume is the
 * declared `Modal.Volume`; at runtime it's a handle (`CreateVolume`) or
 * the reference `Modal.MountVolume` returns.
 */
export interface VolumeMount<V = Ref<{ readonly volumeId: string }>> extends VolumeMountOptions {
  readonly volume: V;
}

/**
 * A cloud bucket mounted at `path` with Modal's cloud bucket mounts: a
 * bucket name, or a bucket resource of another provider (an AWS S3 Bucket,
 * a Cloudflare R2 Bucket). Without `oidcAuthRoleArn`, `secret` holds the
 * bucket's keys (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`, or GCS HMAC
 * keys).
 */
export interface BucketMount<
  B = string | Ref<BucketLike>,
  S = Ref<{ readonly secretId: string }>,
> extends BucketMountOptions {
  readonly bucket: B;
  readonly secret?: S;
}

/** A mount in Stack props (`Modal.Function`, `Server`, `Sandbox`, `PersistentSandbox`). */
export type Mount = VolumeMount | BucketMount;

/** The volume of a runtime mount entry: a volume handle, or a `MountVolume` reference. */
export interface MountedVolume {
  readonly volumeId: Lazy<string>;
}

/** The bucket of a runtime mount entry, as `MountBucket` resolves it. */
export interface MountedBucket {
  readonly bucketName: Lazy<string>;
  readonly endpointUrl?: Lazy<string | undefined>;
  readonly type?: "s3" | "r2" | "gcp";
}

/** A mount for `sandboxes.create`: a plain entry over handles, or a `Mount<Noun>` reference. */
export type SandboxMount =
  | VolumeMount<MountedVolume>
  | BucketMount<string | MountedBucket, { readonly secretId: Lazy<string> }>;

/** A mount entry referenced a resource that isn't bound into this runtime. */
export class MountNotBound extends Data.TaggedError("Modal.MountNotBound")<{
  readonly path: string;
  readonly message: string;
}> {}

/** Modal's mount fields for a set of entries. */
export interface ModalMounts {
  readonly volumeMounts: sandbox.VolumeMount[];
  readonly cloudBucketMounts: sandbox.CloudBucketMount[];
}

const BUCKET_TYPE = { s3: "S3", r2: "R2", gcp: "GCP" } as const;

/** Cloudflare R2's S3 endpoint for an account (and jurisdiction). */
export const r2Endpoint = (accountId: string, jurisdiction?: string): string =>
  `https://${accountId}${
    jurisdiction && jurisdiction !== "default" ? `.${jurisdiction}` : ""
  }.r2.cloudflarestorage.com`;

const value = <T>(input: Lazy<T> | undefined, path: string) =>
  Output.isOutput(input)
    ? Effect.fail(
        new MountNotBound({
          path,
          message: `The mount at ${path} references a declared resource; bind it with Modal.MountVolume or Modal.MountBucket`,
        }),
      )
    : Effect.isEffect(input)
      ? (input as Effect.Effect<T>)
      : Effect.succeed(input as T);

const field = (record: unknown, key: string): unknown =>
  typeof record === "object" && record !== null
    ? (record as Record<string, unknown>)[key]
    : undefined;

/**
 * Modal's `volumeMounts` and `cloudBucketMounts` for mount entries whose
 * resources are resolved: attributes at reconcile, handles or `Mount<Noun>`
 * references at runtime.
 */
export const modalMountsOf = (
  mounts: ReadonlyArray<Mount | SandboxMount> | undefined,
): Effect.Effect<ModalMounts, MountNotBound> =>
  Effect.gen(function* () {
    const volumeMounts: sandbox.VolumeMount[] = [];
    const cloudBucketMounts: sandbox.CloudBucketMount[] = [];
    for (const mount of mounts ?? []) {
      if ("volume" in mount) {
        const volumeId = yield* value(field(mount.volume, "volumeId") as Lazy<string>, mount.path);
        volumeMounts.push({
          mountPath: mount.path,
          volumeId,
          readOnly: mount.readOnly,
          subPath: mount.subPath,
          allowBackgroundCommits: true,
        });
        continue;
      }
      const bucket = mount.bucket;
      const bucketName =
        typeof bucket === "string"
          ? bucket
          : yield* value(field(bucket, "bucketName") as Lazy<string>, mount.path);
      const accountId = field(bucket, "accountId");
      const isR2 = typeof accountId === "string";
      const endpointUrl =
        mount.endpointUrl ??
        (isR2
          ? r2Endpoint(accountId, field(bucket, "jurisdiction") as string | undefined)
          : yield* value(field(bucket, "endpointUrl") as Lazy<string | undefined>, mount.path));
      const type =
        mount.type ?? (field(bucket, "type") as BucketMount["type"]) ?? (isR2 ? "r2" : undefined);
      const secretId = mount.secret
        ? yield* value(field(mount.secret, "secretId") as Lazy<string>, mount.path)
        : undefined;
      cloudBucketMounts.push({
        mountPath: mount.path,
        bucketName,
        bucketType: type ? BUCKET_TYPE[type] : undefined,
        bucketEndpointUrl: endpointUrl,
        credentialsSecretId: secretId,
        keyPrefix: mount.keyPrefix,
        readOnly: mount.readOnly,
        oidcAuthRoleArn: mount.oidcAuthRoleArn,
      });
    }
    return { volumeMounts, cloudBucketMounts };
  });

/**
 * What a Modal runtime's `mounts` binding contract holds: volume and bucket
 * entries (`Modal.MountVolume`, `Modal.MountBucket`), and the install lines
 * of other providers' mount clients (`alchemy/Mount`).
 */
export type MountContract = ReadonlyArray<Mount | MountCapability>;

/** A host's binding data, for its `mounts` slice. */
export type MountBindings = ReadonlyArray<{ readonly data: { readonly mounts?: MountContract } }>;

const isCapability = (entry: Mount | MountCapability): entry is MountCapability =>
  "install" in entry && "id" in entry;

/** The volume and bucket entries a host's bindings contributed, in binding order. */
export const boundMounts = (bindings: MountBindings): ReadonlyArray<Mount> =>
  bindings.flatMap((binding) =>
    (binding.data.mounts ?? []).filter((entry): entry is Mount => !isCapability(entry)),
  );

/** The mount clients other providers' bindings asked the host's image to install. */
export const boundCapabilities = (bindings: MountBindings): ReadonlyArray<MountCapability> =>
  collectMountCapabilities(
    bindings.map((binding) => ({
      data: { mounts: (binding.data.mounts ?? []).filter(isCapability) },
    })),
  );

/**
 * What a Modal container provides to mount clients. Modal runs containers
 * under gVisor without `CAP_SYS_ADMIN`: `/dev/fuse` exists, but `mount`
 * fails with permission denied, for FUSE and NFS alike.
 */
export const MODAL_MOUNT_SUPPORT = { fuse: false, nfs: false } as const;

/** Fail when a mount client needs what a Modal container can't provide. */
export const checkModalMounts = (host: string, capabilities: ReadonlyArray<MountCapability>) => {
  const unsupported = checkMountSupport(
    host,
    capabilities,
    MODAL_MOUNT_SUPPORT,
    "Mount Modal volumes and cloud buckets with Modal.MountVolume and Modal.MountBucket instead.",
  );
  return unsupported === undefined ? Effect.void : Effect.fail(unsupported);
};
