import * as Binding from "alchemy/Binding";
import type * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  type BucketMount,
  type BucketMountOptions,
  type MountedBucket,
  r2Endpoint,
} from "./Mounts.ts";
import { MODAL_RUNTIMES, type MountHost } from "./MountVolume.ts";
import type { Secret } from "./Secret.ts";

/**
 * A bucket resource of another provider: an AWS S3 Bucket, a Cloudflare R2
 * Bucket, a GCS bucket. Its name (and, for R2, its account endpoint) is
 * read from its attributes.
 */
export interface BucketResource {
  readonly Type: string;
  readonly bucketName: Output.Output<string, never>;
}

/** Options for `Modal.MountBucket`: Modal's cloud bucket mount fields, plus the keys' secret. */
export interface MountBucketOptions extends BucketMountOptions {
  /**
   * A `Modal.Secret` holding the bucket's keys (`AWS_ACCESS_KEY_ID` /
   * `AWS_SECRET_ACCESS_KEY`, or GCS HMAC keys). Omit it with `oidcAuthRoleArn`.
   */
  readonly secret?: Secret;
}

/** What `Modal.MountBucket` returns: a mount entry, ready for `mounts`. */
export type BucketMountRef = BucketMount<
  string | MountedBucket,
  { readonly secretId: Effect.Effect<string> }
>;

/**
 * Mount a cloud bucket at `path` with Modal's cloud bucket mounts: a bucket
 * name, or a bucket resource of another provider (an AWS S3 Bucket, a
 * Cloudflare R2 Bucket, whose account endpoint is filled in).
 *
 * - In a `Modal.Function`, `Modal.Server` or `Modal.Sandbox` program, the
 *   bucket is mounted into every container the program runs in.
 * - In any other runtime, the binding returns the entry to pass to
 *   `sandboxes.create({ mounts })`.
 *
 * Modal reads the bucket with the keys in `secret`, or by assuming
 * `oidcAuthRoleArn` with its OIDC identity.
 *
 * ### Mount an R2 bucket
 * **Example:** A sandbox program reading uploads from Cloudflare R2
 * ```typescript
 * import * as Modal from "@alchemy.run/modal";
 * import * as Effect from "effect/Effect";
 * import * as FileSystem from "effect/FileSystem";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import { Coder, R2Keys, Uploads } from "./Storage.ts";
 *
 * export default class Agent extends Modal.Sandbox<Agent>()(
 *   "Agent",
 *   { main: import.meta.url, app: Coder },
 *   Effect.gen(function* () {
 *     const uploads = yield* Modal.MountBucket(Uploads, { path: "/uploads", secret: R2Keys });
 *     const fs = yield* FileSystem.FileSystem;
 *     return {
 *       fetch: Effect.gen(function* () {
 *         return yield* HttpServerResponse.json(yield* fs.readDirectory(uploads.path));
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Modal.MountBucketLive)),
 * ) {}
 * ```
 *
 * @binding
 * @product Volume
 */
export interface MountBucket extends Binding.Service<
  MountBucket,
  "Modal.MountBucket",
  (bucket: string | BucketResource, options: MountBucketOptions) => Effect.Effect<BucketMountRef>
> {}

export const MountBucket = Binding.Service<MountBucket>("Modal.MountBucket");

const R2_BUCKET = "Cloudflare.R2.Bucket";

/**
 * {@link MountBucket}: binds the entry into a Modal runtime's `mounts`, or
 * resolves it for `sandboxes.create` in any other runtime.
 *
 * @layer
 * @product Volume
 * @provides Modal.MountBucket
 */
export const MountBucketLive = Layer.effect(
  MountBucket,
  Effect.succeed(
    Effect.fn("Modal.MountBucket")(function* (
      bucket: string | BucketResource,
      options: MountBucketOptions,
    ) {
      const { secret, ...rest } = options;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (host !== undefined && MODAL_RUNTIMES.has(host.Type)) {
          yield* (host as unknown as MountHost).bind`Modal.MountBucket(${bucket})`({
            mounts: [{ ...rest, bucket, secret }],
          });
        }
      }
      const secretRef = secret === undefined ? undefined : { secretId: yield* secret.secretId };
      if (typeof bucket === "string") {
        return { ...rest, bucket, secret: secretRef } satisfies BucketMountRef;
      }
      const bucketName = yield* bucket.bucketName;
      if (bucket.Type === R2_BUCKET) {
        const r2 = bucket as BucketResource & {
          readonly accountId: Output.Output<string, never>;
          readonly jurisdiction: Output.Output<string | undefined, never>;
        };
        const accountId = yield* r2.accountId;
        const jurisdiction = yield* r2.jurisdiction;
        const endpointUrl = Effect.map(Effect.all([accountId, jurisdiction]), ([account, j]) =>
          r2Endpoint(account, j),
        );
        return {
          ...rest,
          bucket: { bucketName, endpointUrl, type: "r2" },
          secret: secretRef,
        } satisfies BucketMountRef;
      }
      return { ...rest, bucket: { bucketName }, secret: secretRef } satisfies BucketMountRef;
    }),
  ),
);
