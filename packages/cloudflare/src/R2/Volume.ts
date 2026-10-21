import {
  volumeHost,
  type Volume as AIVolume,
  type VolumeHostDescriptor,
  type VolumeHostService,
} from "@alchemy.run/sandbox/Volume";
import * as CoreBinding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import { sha256 } from "alchemy/Util/sha256";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { AccountApiToken } from "../ApiToken/AccountApiToken.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { ContainerApplication } from "../Containers/ContainerApplication.ts";
import type { Providers } from "../Providers.ts";
import { volumeBucketBinding, R2_VOLUME_HOST } from "../Workers/VolumeHeads.ts";
import { isWorker } from "../Workers/Worker.ts";
import { Bucket } from "./Bucket.ts";
import { s3CredentialsPolicy } from "./S3CredentialsBinding.ts";
import { blockdLayer } from "./VolumeBlockd.ts";
import { VolumeImage, type VolumeImageProps } from "./VolumeImage.ts";

export interface VolumeProps {
  /** The volume's size. @default "8 GB" */
  readonly size?: `${number} GB` | number;
  /**
   * The base every fork starts from: a directory of an image built from
   * `dockerfile`. Omitted, an empty filesystem.
   */
  readonly base?: VolumeImageProps["base"];
  /**
   * The filesystem on the volume. btrfs makes merging cheaper (a small
   * write to a big file merges as its bytes) but needs a kernel with btrfs:
   * Cloudflare containers have it, Lambda MicroVMs don't. @default "ext4"
   */
  readonly filesystem?: VolumeImageProps["filesystem"];
}

const bytes = (size: VolumeProps["size"]): number =>
  typeof size === "number" ? size : Number.parseFloat(size ?? "8") * 1024 ** 3;

/**
 * Host a `Sandbox.Volume` declaration in an R2 bucket: its extents, snapshots
 * and heads, through R2's S3 API. The base image is built at deploy. A
 * Worker or Durable Object that yields the volume reads and moves its heads
 * through an R2 binding (metadata only); a sandbox it's mounted on
 * (`Workspace.on(Machine)`) gets blockd, and each command gets S3
 * credentials scoped to the bucket.
 * Returns the Layer that satisfies `yield* Workspace`.
 *
 * ### Hosting a volume
 * **Example:** An 8 GB workspace with an empty base
 * ```typescript
 * // src/Workspace.cloudflare.ts
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import { Workspace } from "./Workspace.ts";
 *
 * export const WorkspaceLive = Cloudflare.R2.Volume(Workspace, { size: "8 GB" });
 * ```
 *
 * **Example:** A base with a checkout and its dependencies
 * ```typescript
 * export const WorkspaceLive = Cloudflare.R2.Volume(Workspace, {
 *   size: "16 GB",
 *   base: {
 *     dockerfile: `FROM node:24-bookworm
 * RUN git clone --depth 1 https://github.com/alchemy-run/alchemy /workspace && cd /workspace && npm ci`,
 *     path: "/workspace",
 *   },
 * });
 * ```
 *
 * @binding
 * @product R2
 * @category Storage & Databases
 */
export const Volume = <const D extends AIVolume.Decl.Any>(
  volume: D,
  props: VolumeProps = {},
): Layer.Layer<AIVolume.Host<SelfOf<D>>, never, Providers> => {
  const id = volume.LogicalId;
  return Layer.effect(
    volumeHost(id),
    Effect.gen(function* () {
      // The volume is the stack's: destroying the stack deletes its heads and snapshots.
      const bucket = yield* Bucket(`${id}Volume`, { forceDestroy: true });
      const { accountId } = yield* yield* CloudflareEnvironment;
      const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
      const token = yield* AccountApiToken(`${id}VolumeToken`);
      yield* token.bind`Volume(${id})`({
        policies: [
          Output.all(bucket.bucketName, bucket.jurisdiction).pipe(
            Output.map(([bucketName, jurisdiction]) =>
              s3CredentialsPolicy(accountId, bucketName, jurisdiction, "read-write"),
            ),
          ),
        ],
      });
      const secretAccessKey = token.value.pipe(
        Output.mapEffect((value) => sha256(Redacted.value(value))),
      );
      const store = bucket.bucketName.pipe(Output.map((name) => `s3://${name}/volumes/${id}`));
      const image = yield* VolumeImage(`${id}Base`, {
        store,
        endpoint,
        accessKeyId: token.tokenId,
        secretAccessKey: secretAccessKey.pipe(Output.map(Redacted.make)),
        size: bytes(props.size),
        ...(props.base ? { base: props.base } : {}),
        ...(props.filesystem && props.filesystem !== "ext4"
          ? { filesystem: props.filesystem }
          : {}),
      });
      const descriptor = Output.all(store, image.head).pipe(
        Output.map(([store, base]): VolumeHostDescriptor => ({
          host: R2_VOLUME_HOST,
          store,
          base,
        })),
      );
      const layer = yield* blockdLayer.pipe(Effect.orDie);
      return {
        descriptor,
        // The yielding Worker reads and moves heads through an R2 binding.
        bind: Effect.gen(function* () {
          const host = yield* CoreBinding.Host;
          if (!host || !isWorker(host)) return;
          yield* host.bind`Volume(${id})`({
            bindings: [
              { type: "r2_bucket", name: volumeBucketBinding(id), bucketName: bucket.bucketName },
            ],
          });
        }),
        // The yielding Worker holds the store's credentials as a secret and
        // passes them to each command: none of them is baked into an image.
        storeEnv: Output.all(token.tokenId, secretAccessKey).pipe(
          Output.map(([accessKeyId, secret]) =>
            Redacted.make(
              JSON.stringify({
                AWS_ACCESS_KEY_ID: accessKeyId,
                AWS_SECRET_ACCESS_KEY: secret,
                AWS_ENDPOINT: endpoint,
                AWS_REGION: "auto",
              }),
            ),
          ),
        ),
        // A sandbox it's mounted on gets blockd.
        install: (application: unknown) =>
          (application as ContainerApplication).bind`Volume(${id})`({ image: [layer] }),
      } satisfies VolumeHostService;
    }),
  ) as unknown as Layer.Layer<AIVolume.Host<SelfOf<D>>, never, Providers>;
};

type SelfOf<D> = D extends AIVolume.Decl<infer Self, any> ? Self : never;
