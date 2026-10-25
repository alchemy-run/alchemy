import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import * as containerregistry from "@distilled.cloud/azure/containerregistry";
import * as acr from "@distilled.cloud/azure/containerregistry-data";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * Container images for Alchemy-bundled programs, built without Docker: the
 * base image is imported into the app's Azure Container Registry
 * repository server-side (`importImage`), and the program is pushed on top
 * of it as one extra layer through the registry data plane. Not exported
 * from `index.ts`.
 */

/** Public Node.js base image the program layer is added to. */
export const DEFAULT_BASE_IMAGE = "mcr.microsoft.com/azurelinux/base/nodejs:24";

/** Directory in the image that holds the program; `index.mjs` is the entry. */
export const APP_DIR = "/app";

export class ImageBuildFailed extends Data.TaggedError("Azure.ContainerApps.ImageBuildFailed")<{
  image: string;
  message: string;
}> {}

/** A file of the program layer, relative to {@link APP_DIR}. */
export interface ImageFile {
  path: string;
  content: Uint8Array;
}

const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
const DOCKER_MANIFEST = "application/vnd.docker.distribution.manifest.v2+json";

const encoder = new TextEncoder();

const sha256Hex = (bytes: Uint8Array) =>
  Effect.sync(() => createHash("sha256").update(bytes).digest("hex"));

const digestOf = (bytes: Uint8Array) => Effect.map(sha256Hex(bytes), (hex) => `sha256:${hex}`);

/**
 * `mcr.microsoft.com/azurelinux/base/nodejs:24` → `{ registryUri, sourceImage }`
 * as `importImage` takes them. A reference without a registry host is a
 * Docker Hub image (`node:24` → `docker.io`, `library/node:24`).
 */
export const parseImageReference = (image: string) => {
  const [first, ...rest] = image.split("/");
  const hasHost =
    rest.length > 0 && (first!.includes(".") || first!.includes(":") || first === "localhost");
  if (hasHost) return { registryUri: first!, sourceImage: rest.join("/") };
  return {
    registryUri: "docker.io",
    sourceImage: rest.length === 0 ? `library/${image}` : image,
  };
};

/** One ustar header block (owner root, mtime 0: the archive is reproducible). */
const tarHeader = (name: string, size: number, type: "0" | "5", mode: number) => {
  const block = new Uint8Array(512);
  const write = (offset: number, value: string, length: number) =>
    encoder.encodeInto(value, block.subarray(offset, offset + length));
  const octal = (offset: number, value: number, length: number) =>
    write(offset, `${value.toString(8).padStart(length - 1, "0")}\0`, length);
  write(0, name, 100);
  octal(100, mode, 8);
  octal(108, 0, 8);
  octal(116, 0, 8);
  octal(124, size, 12);
  octal(136, 0, 12);
  block.fill(0x20, 148, 156);
  block[156] = type.charCodeAt(0);
  write(257, "ustar", 6);
  write(263, "00", 2);
  let sum = 0;
  for (const byte of block) sum += byte;
  write(148, `${sum.toString(8).padStart(6, "0")}\0 `, 8);
  return block;
};

/** A tar of `files` under `app/`, with its directory entries. */
const tarFiles = (files: readonly ImageFile[]) =>
  Effect.sync(() => {
    const blocks: Uint8Array[] = [];
    const root = APP_DIR.slice(1);
    const dirs = new Set<string>([root]);
    for (const file of files) {
      const parts = `${root}/${file.path}`.split("/");
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
    }
    for (const dir of [...dirs].sort()) blocks.push(tarHeader(`${dir}/`, 0, "5", 0o755));
    for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
      const name = `${root}/${file.path}`;
      if (encoder.encode(name).byteLength > 100) {
        return { error: `path too long for the image layer: ${name}` } as const;
      }
      blocks.push(tarHeader(name, file.content.byteLength, "0", 0o644), file.content);
      const pad = (512 - (file.content.byteLength % 512)) % 512;
      if (pad > 0) blocks.push(new Uint8Array(pad));
    }
    blocks.push(new Uint8Array(1024));
    const size = blocks.reduce((n, b) => n + b.byteLength, 0);
    const tar = new Uint8Array(size);
    let offset = 0;
    for (const b of blocks) {
      tar.set(b, offset);
      offset += b.byteLength;
    }
    return { tar } as const;
  });

const gzip = (bytes: Uint8Array) =>
  Effect.sync(() => new Uint8Array(gzipSync(bytes, { level: 9 })));

/** Upload `body` as one blob of `repository` (monolithic upload). */
const uploadBlob = (endpoint: string, repository: string, body: Uint8Array) =>
  Effect.gen(function* () {
    const digest = yield* digestOf(body);
    const started = yield* acr.ContainerRegistryBlobStartUpload({ endpoint, name: repository });
    yield* acr.UploadContainerRegistryBlobComplete({
      endpoint,
      nextBlobUuidLink: started.location ?? `/v2/${repository}/blobs/uploads/`,
      digest,
      body,
    });
    return { digest, size: body.byteLength };
  });

/** The manifest at `reference`, or `undefined` when the tag or repository is missing. */
const findManifest = (endpoint: string, repository: string, reference: string) =>
  acr
    .GetContainerRegistryManifest({ endpoint, name: repository, reference })
    .pipe(
      Effect.catchTag(
        ["ContainerRegistryManifestNotFound", "ContainerRegistryRepositoryNotFound"],
        () => Effect.succeed(undefined),
      ),
    );

export interface PushProgramImageOptions {
  subscriptionId: string;
  resourceGroup: string;
  registryName: string;
  /** `<name>.azurecr.io`. */
  loginServer: string;
  /** Repository of the app, e.g. `my-app`. */
  repository: string;
  /** Tag of the program image: the program's content hash. */
  tag: string;
  /** Public base image. */
  baseImage: string;
  /** Program files, placed under {@link APP_DIR}. */
  files: readonly ImageFile[];
  /** Process arguments after `node`, e.g. `["/app/index.mjs"]`. */
  entrypoint: string[];
}

/**
 * Make `<loginServer>/<repository>:<tag>` exist: the base image (linux/amd64)
 * plus one layer holding `files`, run as `node <entrypoint>`. A tag that
 * already exists is reused, so a redeploy of unchanged code pushes nothing.
 * Returns the image reference.
 */
export const pushProgramImage = Effect.fn(function* (options: PushProgramImageOptions) {
  const endpoint = `https://${options.loginServer}`;
  const repository = options.repository;
  const image = `${options.loginServer}/${repository}:${options.tag}`;
  const fail = (message: string) => Effect.fail(new ImageBuildFailed({ image, message }));

  if ((yield* findManifest(endpoint, repository, options.tag)) !== undefined) return image;

  // Copy the base image into the repository (server side), once per base.
  const baseTag = `base-${(yield* sha256Hex(encoder.encode(options.baseImage))).slice(0, 16)}`;
  if ((yield* findManifest(endpoint, repository, baseTag)) === undefined) {
    yield* containerregistry.ImportRegistryImage({
      subscriptionId: options.subscriptionId,
      resourceGroupName: options.resourceGroup,
      registryName: options.registryName,
      source: parseImageReference(options.baseImage),
      targetTags: [`${repository}:${baseTag}`],
      mode: "Force",
    });
  }
  // The import runs asynchronously: wait for the tag (3 minutes at most).
  const imported = yield* findManifest(endpoint, repository, baseTag).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (manifest) => manifest !== undefined,
      times: 36,
    }),
  );
  if (imported === undefined) {
    return yield* fail(`importing ${options.baseImage} did not finish`);
  }

  // A multi-platform base: use its linux/amd64 image.
  let base = imported;
  if (imported.manifests !== undefined) {
    const entry = imported.manifests.find(
      (m) => m.platform?.os === "linux" && m.platform?.architecture === "amd64",
    );
    if (entry?.digest === undefined) {
      return yield* fail(`${options.baseImage} has no linux/amd64 image`);
    }
    const platform = yield* findManifest(endpoint, repository, entry.digest);
    if (platform === undefined) {
      return yield* fail(`${options.baseImage}@${entry.digest} was not imported`);
    }
    base = platform;
  }
  if (base.config?.digest === undefined || base.layers === undefined) {
    return yield* fail(`${options.baseImage} is not an OCI or Docker v2 image`);
  }

  const baseConfigBlob = yield* acr.GetContainerRegistryBlobBlob({
    endpoint,
    name: repository,
    digest: base.config.digest,
  });
  const baseConfig = yield* Effect.try({
    try: () =>
      JSON.parse(new TextDecoder().decode(baseConfigBlob.body)) as {
        config?: Record<string, unknown> & { Env?: string[] };
        rootfs?: { type?: string; diff_ids?: string[] };
        history?: unknown[];
        [key: string]: unknown;
      },
    catch: () => new ImageBuildFailed({ image, message: "the base image config is not JSON" }),
  });

  // The program layer.
  const archive = yield* tarFiles(options.files);
  if ("error" in archive) return yield* fail(archive.error);
  const diffId = yield* digestOf(archive.tar);
  const layerBytes = yield* gzip(archive.tar);
  const layer = yield* uploadBlob(endpoint, repository, layerBytes);

  const { Cmd: _cmd, ...baseContainerConfig } = baseConfig.config ?? {};
  const config = {
    ...baseConfig,
    config: {
      ...baseContainerConfig,
      Entrypoint: ["node", ...options.entrypoint],
      WorkingDir: APP_DIR,
      Env: [
        ...(baseConfig.config?.Env ?? []).filter((e) => !e.startsWith("NODE_ENV=")),
        "NODE_ENV=production",
      ],
    },
    rootfs: { type: "layers", diff_ids: [...(baseConfig.rootfs?.diff_ids ?? []), diffId] },
    history: [
      ...(baseConfig.history ?? []),
      { created: "1970-01-01T00:00:00Z", created_by: `alchemy: COPY program ${APP_DIR}` },
    ],
  };
  const configBlob = yield* uploadBlob(
    endpoint,
    repository,
    encoder.encode(JSON.stringify(config)),
  );

  const oci =
    base.mediaType === OCI_MANIFEST ||
    (base.mediaType === undefined && (base.config.mediaType ?? "").includes(".oci."));
  const manifest = {
    schemaVersion: 2,
    mediaType: oci ? OCI_MANIFEST : DOCKER_MANIFEST,
    config: {
      mediaType: oci
        ? "application/vnd.oci.image.config.v1+json"
        : "application/vnd.docker.container.image.v1+json",
      size: configBlob.size,
      digest: configBlob.digest,
    },
    layers: [
      ...base.layers.map((l) => ({ mediaType: l.mediaType, size: l.size, digest: l.digest })),
      {
        mediaType: oci
          ? "application/vnd.oci.image.layer.v1.tar+gzip"
          : "application/vnd.docker.image.rootfs.diff.tar.gzip",
        size: layer.size,
        digest: layer.digest,
      },
    ],
  };
  yield* acr.CreateContainerRegistryManifest({
    endpoint,
    name: repository,
    reference: options.tag,
    payload: encoder.encode(JSON.stringify(manifest)),
    contentType: manifest.mediaType,
  });
  return image;
});
