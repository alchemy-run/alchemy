import { createHash } from "node:crypto";
import * as image from "@distilled.cloud/modal/image";
import * as mount from "@distilled.cloud/modal/mount";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { BlobOps, MAX_INLINE_BYTES, uploadBlob } from "./Blob.ts";
import { operations } from "./internal.ts";

/** Modal's builder finished the image build with a failure. */
export class ImageBuildFailed extends Data.TaggedError("Modal.ImageBuildFailed")<{
  readonly imageId: string;
  readonly status: string;
  readonly message: string;
  /** The last lines the build printed. */
  readonly logs: string;
}> {}

/** The build didn't finish within its time budget. */
export class ImageBuildTimeout extends Data.TaggedError("Modal.ImageBuildTimeout")<{
  readonly imageId: string;
  readonly message: string;
}> {}

/** What an image is built from, after Dockerfile lowering. */
export interface ImageBuildSpec {
  /** A registry image to start from (`FROM <ref>`). */
  readonly dockerTag?: string;
  /** A Modal image to start from. */
  readonly baseImageId?: string;
  /**
   * Dockerfile commands. With `dockerTag`/`baseImageId` they follow the
   * generated `FROM`; otherwise they are a whole Dockerfile.
   */
  readonly commands: ReadonlyArray<string>;
  /**
   * Files the commands `COPY`, by context-relative path. They are uploaded
   * as a mount owned by the app, so their size isn't limited by Modal's
   * 2 MB cap on an image definition.
   */
  readonly contextFiles?: ReadonlyArray<{
    readonly filename: string;
    readonly data: Uint8Array;
    /** Permission bits. @default 0o644 */
    readonly mode?: number;
  }>;
  /**
   * A mount whose files the commands `COPY` (e.g. Modal's standalone
   * Python). Not combined with {@link contextFiles}.
   */
  readonly contextMountId?: string;
  /** Build arguments (`ARG` values). */
  readonly buildArgs?: Readonly<Record<string, string>>;
  /** Secrets (ids) the build steps see as environment variables. */
  readonly secretIds?: ReadonlyArray<string>;
  /** Credentials to pull a private base image. */
  readonly registry?: {
    readonly authType: "aws" | "gcp" | "static";
    readonly secretId: string;
  };
  /** Run the build on a GPU (`"A10G"`, `"H100"`, ...). */
  readonly gpu?: string;
  readonly builderVersion?: string;
  readonly forceBuild?: boolean;
}

const AUTH_TYPE = {
  aws: "REGISTRY_AUTH_TYPE_AWS",
  gcp: "REGISTRY_AUTH_TYPE_GCP",
  static: "REGISTRY_AUTH_TYPE_STATIC_CREDS",
} as const;

/** A `"A100-80GB:2"`-style GPU spec as Modal's `GPUConfig`. */
export const gpuConfig = (gpu: string | undefined): image.GPUConfig | undefined => {
  if (gpu === undefined) return undefined;
  const [type, count] = gpu.split(":");
  return { gpuType: type!.toUpperCase(), count: count ? Number(count) : 1 };
};

/** The operations a build needs, resolved by `ModalBindings.withCredentials` (or at deploy). */
export const ImageBuildOps = operations({
  getOrCreate: image.imageGetOrCreate,
  joinStreaming: image.imageJoinStreaming,
  putFile: mount.mountPutFile,
  getOrCreateMount: mount.mountGetOrCreate,
  blobs: BlobOps,
});

export type ImageBuildOps = Effect.Success<typeof ImageBuildOps>;

/** Modal returned a response without a field the build needs. */
export class ImageBuildUnexpectedResponse extends Data.TaggedError(
  "Modal.ImageBuildUnexpectedResponse",
)<{
  readonly message: string;
}> {}

/**
 * Upload build context files as a mount owned by the app, the way Modal's
 * clients send `COPY` sources. Modal stores files by content hash, so
 * unchanged files are not sent again.
 */
const contextMount = Effect.fn(function* (
  ops: ImageBuildOps,
  appId: string,
  files: NonNullable<ImageBuildSpec["contextFiles"]>,
) {
  const entries = [];
  for (const file of files) {
    const sha256Hex = yield* Effect.sync(() =>
      createHash("sha256").update(file.data).digest("hex"),
    );
    const known = yield* ops.putFile({ sha256Hex });
    if (!known.exists) {
      const upload =
        file.data.length > MAX_INLINE_BYTES
          ? { dataBlobId: yield* uploadBlob(ops.blobs, file.data) }
          : { data: yield* Effect.sync(() => Buffer.from(file.data).toString("base64")) };
      const put = yield* ops.putFile({ sha256Hex, ...upload });
      if (!put.exists) {
        return yield* new ImageBuildUnexpectedResponse({
          message: `Modal didn't store build context file ${file.filename}`,
        });
      }
    }
    entries.push({
      filename: `/${file.filename.replace(/^\/+/, "")}`,
      sha256Hex,
      size: String(file.data.length),
      mode: 0o100000 | ((file.mode ?? 0o644) & 0o7777),
    });
  }
  const { mountId } = yield* ops.getOrCreateMount({
    objectCreationType: "OBJECT_CREATION_TYPE_ANONYMOUS_OWNED_BY_APP",
    appId,
    files: entries,
  });
  if (!mountId) {
    return yield* new ImageBuildUnexpectedResponse({
      message: "Modal returned no id for the build context mount",
    });
  }
  return mountId;
});

const FINISHED = (status: string | undefined) =>
  status !== undefined && status !== "GENERIC_STATUS_UNSPECIFIED";

/**
 * Build (or reuse) an image with Modal's builder and wait until it is ready.
 * Modal content-addresses images, so the same spec returns the same image
 * without rebuilding. Fails with {@link ImageBuildFailed} on a failed build.
 */
export const buildImage = Effect.fn(function* (
  ops: ImageBuildOps,
  appId: string,
  spec: ImageBuildSpec,
  options: { readonly note?: (message: string) => Effect.Effect<void> } = {},
) {
  const from = spec.baseImageId
    ? { baseImages: [{ imageId: spec.baseImageId, dockerTag: "base" }], first: ["FROM base"] }
    : spec.dockerTag
      ? { baseImages: [], first: [`FROM ${spec.dockerTag}`] }
      : { baseImages: [], first: [] as string[] };
  const contextMountId =
    spec.contextFiles !== undefined && spec.contextFiles.length > 0
      ? yield* contextMount(ops, appId, spec.contextFiles)
      : spec.contextMountId;
  const created = yield* ops.getOrCreate({
    appId,
    image: {
      baseImages: from.baseImages,
      dockerfileCommands: [...from.first, ...spec.commands],
      contextMountId,
      secretIds: spec.secretIds ? [...spec.secretIds] : undefined,
      imageRegistryConfig: spec.registry
        ? { registryAuthType: AUTH_TYPE[spec.registry.authType], secretId: spec.registry.secretId }
        : undefined,
      gpuConfig: gpuConfig(spec.gpu),
      buildArgs: spec.buildArgs ? { ...spec.buildArgs } : undefined,
    },
    builderVersion: spec.builderVersion,
    forceBuild: spec.forceBuild,
  });
  const imageId = created.imageId;
  if (!imageId) {
    return yield* new ImageBuildFailed({
      imageId: "",
      status: "GENERIC_STATUS_UNSPECIFIED",
      message: "Modal returned no image id",
      logs: "",
    });
  }
  let result = created.result;
  let lastEntryId: string | undefined;
  const logs: string[] = [];
  // Each join call streams build logs for up to ~55 s; a build may take many.
  for (let attempt = 0; !FINISHED(result?.status) && attempt < 60; attempt++) {
    if (attempt === 0 && options.note) yield* options.note(`Building image ${imageId}...`);
    const { items } = yield* ops.joinStreaming({
      imageId,
      timeout: 55,
      lastEntryId,
      includeLogsForFinished: true,
    });
    for (const item of items) {
      if (item.entryId) lastEntryId = item.entryId;
      for (const log of item.taskLogs ?? []) {
        if (log.data) logs.push(log.data);
      }
      if (FINISHED(item.result?.status)) result = item.result;
    }
  }
  if (!FINISHED(result?.status)) {
    return yield* new ImageBuildTimeout({
      imageId,
      message: `Modal image ${imageId} was still building after 55 minutes`,
    });
  }
  if (result?.status !== "GENERIC_STATUS_SUCCESS") {
    return yield* new ImageBuildFailed({
      imageId,
      status: result?.status ?? "GENERIC_STATUS_UNSPECIFIED",
      message: result?.exception || `Modal image build ${imageId} ended with ${result?.status}`,
      logs: logs.join("").split("\n").slice(-40).join("\n"),
    });
  }
  return imageId;
});
