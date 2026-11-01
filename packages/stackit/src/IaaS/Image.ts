import { createHash } from "node:crypto";
import * as iaas from "@distilled.cloud/stackit/iaas";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { StackitEnvironment } from "../Environment.ts";
import { hasUnresolvedTrigger } from "../internal/diff.ts";
import { waitFor, waitUntilGone } from "../internal/wait.ts";
import {
  desiredGenerationLabels,
  hasAlchemyLabels,
  isAlchemyOwned,
  stripInternalLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  conflictRetry,
  findOwnedByName,
  iaasName,
  labelsPatch,
  ownedOnly,
  projectScopeChanged,
  readGeneration,
  resolveProjectScope,
  type ProjectScope,
  type ProjectScopedProps,
} from "./internal.ts";

/** The local image file is not a non-empty regular file. */
export class ImageFileInvalid extends Data.TaggedError("Stackit.IaaS.ImageFileInvalid")<{
  readonly path: string;
  readonly message: string;
}> {}

/** Uploading the image data to the presigned URL failed. */
export class ImageUploadFailed extends Data.TaggedError("Stackit.IaaS.ImageUploadFailed")<{
  readonly resourceName: string;
  /** HTTP status of the upload, when one was received. */
  readonly status: number | undefined;
  readonly message: string;
}> {}

/** The checksum STACKIT computed differs from the uploaded file's. */
export class ImageChecksumMismatch extends Data.TaggedError("Stackit.IaaS.ImageChecksumMismatch")<{
  readonly resourceName: string;
  readonly algorithm: string;
  readonly expected: string;
  readonly actual: string;
  readonly message: string;
}> {}

/** STACKIT returned an image without an id. */
export class ImageIdMissing extends Data.TaggedError("Stackit.IaaS.ImageIdMissing")<{
  readonly resourceName: string;
  readonly message: string;
}> {}

/** Disk format of an image. */
export type ImageDiskFormat = "raw" | "qcow2" | "iso";

/** Upload a local file as the image data. */
export interface ImageFileSource {
  /** Upload a local file. */
  type: "file";
  /**
   * Path of the image file on the machine running the deploy, absolute or
   * relative to the working directory. It must exist at every plan: its
   * content is hashed to detect changes. New content replaces the image.
   */
  path: string;
}

/** Create the image from an existing volume. */
export interface ImageVolumeSource {
  /** Copy an existing volume. */
  type: "volume";
  /** Volume to copy. A different volume replaces the image. */
  volumeId: string;
  /**
   * Copy the volume even though a server is using it. The image may then
   * hold an inconsistent disk state.
   * @default false
   */
  force?: boolean;
}

/** Where the data of an image comes from. */
export type ImageSource = ImageFileSource | ImageVolumeSource;

/** Support and default provisioning of the STACKIT server agent. */
export interface ImageAgentProps {
  /** Whether the image supports the STACKIT server agent. */
  supported?: boolean;
  /**
   * Provision the agent on new servers by default. Needs `supported`.
   */
  provisionByDefault?: boolean;
}

/** Hardware and scheduling settings of an image. */
export interface ImageConfigProps {
  /** CPU architecture: `x86` or `arm64`. */
  architecture?: string;
  /** Show the BIOS boot menu. */
  bootMenu?: boolean;
  /** CDROM bus: `scsi`, `virtio`, `ide` or `usb`. */
  cdromBus?: string;
  /** Disk bus: `scsi`, `virtio`, `ide` or `usb`. */
  diskBus?: string;
  /**
   * Virtual NIC model: `e1000`, `e1000e`, `ne2k_pci`, `pcnet`, `rtl8139`,
   * `virtio` or `vmxnet3`.
   */
  nicModel?: string;
  /** Enable OS-specific optimizations: `windows` or `linux`. */
  operatingSystem?: string;
  /** Operating system distribution. */
  operatingSystemDistro?: string;
  /** Version of the operating system. */
  operatingSystemVersion?: string;
  /** Rescue device bus: `sata`, `scsi`, `virtio` or `usb`. */
  rescueBus?: string;
  /** Rescue device: `cdrom` or `disk`. */
  rescueDevice?: string;
  /** Enable Secure Boot. */
  secureBoot?: boolean;
  /** Boot with UEFI. */
  uefi?: boolean;
  /** Graphics device: `vga`, `cirrus`, `vmvga`, `qxl`, `virtio` or `none`. */
  videoModel?: string;
  /** Use VirtIO SCSI for block devices instead of VirtIO Block. */
  virtioScsi?: boolean;
}

export interface ImageProps extends ProjectScopedProps {
  /**
   * Where the image data comes from: a local file (`type: "file"`) or an
   * existing volume (`type: "volume"`). Changing the file's content, the
   * volume, or the kind of source replaces the image.
   */
  source: ImageSource;
  /**
   * Disk format of the image data: `raw`, `qcow2` or `iso`. Changing it
   * replaces the image.
   */
  diskFormat: ImageDiskFormat;
  /**
   * Name of the image. Updated in place.
   * @default a physical name generated from the app, stage and logical id
   */
  name?: string;
  /** Smallest boot volume, in GB, a server needs. Updated in place; unmanaged when omitted. */
  minDiskSize?: number;
  /** Least RAM, in MB, a server needs. Updated in place; unmanaged when omitted. */
  minRam?: number;
  /**
   * Prevent the image from being deleted. Updated in place; unmanaged when
   * omitted. Alchemy never lifts this for you: deploy with `protected: false`
   * before destroying or replacing the image.
   */
  protected?: boolean;
  /**
   * Hardware and scheduling settings. Only the fields you set are managed,
   * and updated in place; the others keep their live values.
   */
  config?: ImageConfigProps;
  /**
   * STACKIT server agent support. Only the fields you set are managed, and
   * updated in place.
   */
  agent?: ImageAgentProps;
  /**
   * Project of the image. Defaults to the profile's project. Changing it
   * replaces the image.
   */
  projectId?: string;
  /**
   * Region of the image. Defaults to the profile's region. Changing it
   * replaces the image.
   */
  region?: string;
  /**
   * User labels. Alchemy's ownership labels (`alchemy.stack`,
   * `alchemy.stage`, `alchemy.id`, `alchemy.instance`) are added
   * automatically.
   */
  labels?: Record<string, string>;
}

export interface ImageAttributes {
  /** Image id (UUID); use it as a server's `imageId` or a volume `source`. */
  imageId: string;
  /** Name of the image. */
  name: string;
  /** Disk format of the image data. */
  diskFormat: string;
  /** Status, `AVAILABLE` after every successful deploy. */
  status: string | undefined;
  /** Size of the image data in bytes. */
  size: number | undefined;
  /** Smallest boot volume, in GB, a server needs. */
  minDiskSize: number | undefined;
  /** Least RAM, in MB, a server needs. */
  minRam: number | undefined;
  /** Whether the image is protected from deletion. */
  protected: boolean | undefined;
  /** Visibility of the image: `local`, `projects`, `organization` or `public`. */
  scope: string | undefined;
  /** Checksum STACKIT computed from the image data. */
  checksum: iaas.ImageChecksum | undefined;
  /** Hardware and scheduling settings. */
  config: iaas.ImageConfig | undefined;
  /** STACKIT server agent support. */
  agent: iaas.ImageAgent | undefined;
  /**
   * SHA-512 of the local file this image was uploaded from. Undefined for an
   * image from a volume, and for an adopted image until its first update.
   */
  fileSha512: string | undefined;
  /** Volume the image was copied from; undefined for an adopted or uploaded image. */
  sourceVolumeId: string | undefined;
  /** Project of the image. */
  projectId: string;
  /** Region of the image. */
  region: string;
  /** User labels (Alchemy's ownership labels stripped). */
  labels: Record<string, string>;
}

export type Image = Resource<"Stackit.IaaS.Image", ImageProps, ImageAttributes, never, Providers>;

/**
 * A STACKIT server image: a disk template to boot servers and create volumes
 * from, either uploaded from a local file or copied from a volume.
 *
 * A deploy waits until the image reports `AVAILABLE`, which can take many
 * minutes for a large image. The image data is fixed: new file content or a
 * different volume replaces the image, while the name, labels, minimum
 * requirements, `protected`, `config` and `agent` update in place.
 *
 * ### Uploading a local file
 * **Example:** A qcow2 image from a file
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const image = yield* Stackit.IaaS.Image("Base", {
 *   source: { type: "file", path: "./images/base.qcow2" },
 *   diskFormat: "qcow2",
 *   minDiskSize: 10,
 *   minRam: 1024,
 *   labels: { team: "platform" },
 * });
 * ```
 *
 * The file is streamed, never loaded into memory, and is hashed at every plan
 * to detect new content, so it must exist on the machine running the deploy.
 * After the upload the file's digest is compared with the checksum STACKIT
 * computed; on a mismatch the image is deleted and the deploy fails with
 * `Stackit.IaaS.ImageChecksumMismatch`.
 *
 * Uploading needs the optional peer dependency `@effect/platform-node`, also
 * on Bun: the upload URL needs a `Content-Length`, which the fetch client does
 * not send for a streamed body. STACKIT documents this upload path for small
 * images and may refuse a larger file.
 *
 * ### Copying a volume
 * **Example:** An image of a data volume
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const golden = yield* Stackit.IaaS.Volume("Golden", { size: 20 });
 * const image = yield* Stackit.IaaS.Image("Golden", {
 *   source: { type: "volume", volumeId: golden.volumeId },
 *   diskFormat: "qcow2",
 * });
 * ```
 *
 * STACKIT sets no labels when it copies a volume, so Alchemy adds them right
 * after. If a deploy is interrupted in between, an image with a generated name
 * is still found on the next run; one with an explicit `name` is not, and is
 * left behind for you to delete.
 *
 * ### Configuring hardware and boot settings
 * **Example:** An ARM image booting with UEFI and Secure Boot
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const image = yield* Stackit.IaaS.Image("Arm", {
 *   source: { type: "file", path: "./images/arm64.raw" },
 *   diskFormat: "raw",
 *   config: {
 *     architecture: "arm64",
 *     operatingSystem: "linux",
 *     uefi: true,
 *     secureBoot: true,
 *   },
 *   agent: { supported: true, provisionByDefault: true },
 * });
 * ```
 *
 * ### Booting a server
 * **Example:** A server's boot volume from the image
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const image = yield* Stackit.IaaS.Image("Base", {
 *   source: { type: "file", path: "./images/base.qcow2" },
 *   diskFormat: "qcow2",
 * });
 * const network = yield* Stackit.IaaS.Network("App", {
 *   ipv4: { prefix: "10.0.1.0/24" },
 * });
 * const server = yield* Stackit.IaaS.Server("Web", {
 *   machineType: "g1.1",
 *   bootVolume: { size: 20, source: { type: "image", id: image.imageId } },
 *   networking: { networkId: network.networkId },
 * });
 * ```
 *
 * ### Protecting an image from deletion
 * **Example:** A protected image
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const image = yield* Stackit.IaaS.Image("Release", {
 *   source: { type: "file", path: "./images/release.qcow2" },
 *   diskFormat: "qcow2",
 *   protected: true,
 * });
 * ```
 *
 * STACKIT refuses to delete a protected image, and Alchemy does not lift the
 * protection for you, so `destroy` and any replacement fail until you deploy
 * with `protected: false`.
 *
 * ### Replacement <!-- api-prose -->
 * New file content, a different volume or source kind, `diskFormat`,
 * `projectId` and `region` all create a new image and delete the old one.
 * Servers already booted from the old image keep running.
 *
 * @resource
 * @product STACKIT Compute Engine
 * @category IaaS
 */
export const Image = Resource<Image>("Stackit.IaaS.Image");

/** Importing an uploaded image can take many minutes. */
const READY_TIMEOUT = "30 minutes";

const DELETE_TIMEOUT = "5 minutes";

/** Longest a single file upload may run. */
const UPLOAD_TIMEOUT = "1 hour";

const isReady = (image: iaas.Image) => image.status === "AVAILABLE";

const hasFailed = (image: iaas.Image) =>
  image.status === "ERROR" || image.status === "DEACTIVATED" || image.status === "DELETED"
    ? image.status
    : undefined;

const stateOf = (image: iaas.Image) =>
  image.importProgress === undefined
    ? image.status
    : `${image.status ?? "UNKNOWN"} (import ${image.importProgress}%)`;

/** Facts about a local image file. */
interface ImageFile {
  readonly path: string;
  readonly size: number;
  readonly md5: string;
  readonly sha512: string;
}

/**
 * Stat and hash a local image file. Both digests come from one streamed read,
 * since the API may report its checksum in either algorithm.
 */
const inspectFile = Effect.fn(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(path);
  const size = Number(info.size);
  if (info.type !== "File" || size === 0) {
    return yield* new ImageFileInvalid({
      path,
      message: `Image file ${path} must be a non-empty regular file`,
    });
  }
  const md5 = yield* Effect.sync(() => createHash("md5"));
  const sha512 = yield* Effect.sync(() => createHash("sha512"));
  yield* fs.stream(path).pipe(
    Stream.runForEach((chunk) =>
      Effect.sync(() => {
        md5.update(chunk);
        sha512.update(chunk);
      }),
    ),
  );
  return {
    path,
    size,
    md5: yield* Effect.sync(() => md5.digest("hex")),
    sha512: yield* Effect.sync(() => sha512.digest("hex")),
  } satisfies ImageFile;
});

/** Whether STACKIT's checksum agrees with the file. An absent or unknown checksum can't disagree. */
const checksumMatches = (checksum: iaas.ImageChecksum | undefined, file: ImageFile): boolean => {
  if (checksum?.algorithm === "sha512") return checksum.digest === file.sha512;
  if (checksum?.algorithm === "md5") return checksum.digest === file.md5;
  return true;
};

const checksumOf = (checksum: iaas.ImageChecksum, file: ImageFile) =>
  checksum.algorithm === "md5" ? file.md5 : file.sha512;

/** Whether the deployed image still holds the desired source's data. */
const sameSource = (
  output: ImageAttributes,
  volume: ImageVolumeSource | undefined,
  file: ImageFile | undefined,
): boolean => {
  if (volume !== undefined) {
    return (
      output.fileSha512 === undefined &&
      (output.sourceVolumeId === undefined || output.sourceVolumeId === volume.volumeId)
    );
  }
  if (file === undefined || output.sourceVolumeId !== undefined) return false;
  return output.fileSha512 !== undefined
    ? output.fileSha512 === file.sha512
    : checksumMatches(output.checksum, file);
};

/**
 * The transport of the upload. `FetchHttpClient` strips `Content-Length` and
 * sends a streamed body chunked, and presigned upload URLs need the length
 * (the STACKIT Terraform provider sets it too). The node transport keeps it,
 * under Bun as well. Imported lazily because the peer dependency is optional.
 */
const uploadTransport = (resourceName: string) =>
  Layer.unwrap(
    Effect.tryPromise({
      try: () => import("@effect/platform-node/NodeHttpClient"),
      catch: () =>
        new ImageUploadFailed({
          resourceName,
          status: undefined,
          message:
            'Uploading an image file needs the peer dependency "@effect/platform-node"; install it next to "alchemy"',
        }),
    }).pipe(Effect.map((module) => module.layerNodeHttp)),
  );

/**
 * Stream a local file to the upload URL `createImage` returned. This is the
 * one raw HTTP call of the provider: the URL is presigned and handed back by
 * the API, so it is not an API operation distilled could model.
 *
 * The URL carries a signature, so errors name only the image, never the
 * request.
 */
const uploadFile = Effect.fn(function* (input: {
  readonly uploadUrl: string;
  readonly file: ImageFile;
  readonly resourceName: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const request = HttpClientRequest.put(input.uploadUrl).pipe(
    HttpClientRequest.bodyStream(fs.stream(input.file.path), {
      contentType: "application/octet-stream",
      contentLength: input.file.size,
    }),
  );
  const response = yield* Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    return yield* http.execute(request).pipe(
      Effect.mapError(
        (error) =>
          new ImageUploadFailed({
            resourceName: input.resourceName,
            status: undefined,
            message: `Uploading image ${input.resourceName} failed before a response arrived (${error.reason._tag})`,
          }),
      ),
    );
  }).pipe(
    Effect.provide(uploadTransport(input.resourceName)),
    Effect.timeoutOption(UPLOAD_TIMEOUT),
  );
  if (Option.isNone(response)) {
    return yield* new ImageUploadFailed({
      resourceName: input.resourceName,
      status: undefined,
      message: `Uploading image ${input.resourceName} timed out after ${UPLOAD_TIMEOUT}`,
    });
  }
  const { status } = response.value;
  if (status < 200 || status >= 300) {
    return yield* new ImageUploadFailed({
      resourceName: input.resourceName,
      status,
      message: `Uploading image ${input.resourceName} failed with HTTP ${status}`,
    });
  }
});

const toAttrs = (
  image: iaas.Image,
  scope: ProjectScope,
  source: { readonly fileSha512: string | undefined; readonly sourceVolumeId: string | undefined },
): ImageAttributes => ({
  imageId: image.id ?? "",
  name: image.name,
  diskFormat: image.diskFormat,
  status: image.status,
  size: image.size,
  minDiskSize: image.minDiskSize,
  minRam: image.minRam,
  protected: image.protected,
  scope: image.scope,
  checksum: image.checksum,
  config: image.config,
  agent: image.agent,
  ...source,
  ...scope,
  labels: stripInternalLabels(image.labels),
});

/** The image, or `undefined` once it is gone (`DELETED` still reads for a while). */
const getImage = (scope: ProjectScope, imageId: string) =>
  iaas.getImage({ ...scope, imageId }).pipe(
    Effect.map((image) => (image.status === "DELETED" ? undefined : image)),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

const observe = Effect.fn(function* (args: {
  id: string;
  name: string;
  scope: ProjectScope;
  imageId: string | undefined;
  instanceId: string | undefined;
  /** The name is generated, so it identifies the image even without labels. */
  generatedName: boolean;
}) {
  if (args.imageId !== undefined) {
    const byId = yield* getImage(args.scope, args.imageId);
    if (byId !== undefined) return byId;
  }
  // Crash recovery: a create whose state was never persisted.
  const { items } = yield* iaas.listImages(args.scope);
  const live = items.filter((image) => image.status !== "DELETED");
  const owned = yield* findOwnedByName(args.id, args.name, live, {
    instanceId: args.instanceId,
  });
  if (owned !== undefined) return owned;
  // `imageFromVolume` takes no labels, so an interrupted create has none. A
  // generated name embeds the instance id, which is proof enough.
  return args.generatedName
    ? live.find((image) => image.name === args.name && !isAlchemyOwned(image.labels))
    : undefined;
});

/** Remove an image and wait until it is gone. Idempotent. */
const removeImage = Effect.fn(function* (image: {
  readonly scope: ProjectScope;
  readonly imageId: string;
  readonly name: string;
  readonly deleting: boolean;
}) {
  if (!image.deleting) {
    yield* iaas
      .deleteImage({ ...image.scope, imageId: image.imageId })
      .pipe(Effect.catchTag("NotFound", () => Effect.void));
  }
  yield* waitUntilGone({
    resource: `STACKIT image ${image.name}`,
    read: getImage(image.scope, image.imageId),
    state: stateOf,
    failed: (observed) => (observed.status === "ERROR" ? observed.status : undefined),
    timeout: DELETE_TIMEOUT,
  });
});

/** Whether the observed fields differ from the fields set in `desired`. */
const drifted = <T extends object>(observed: T | undefined, desired: T): boolean =>
  (Object.keys(desired) as Array<keyof T>).some(
    (key) => desired[key] !== undefined && observed?.[key] !== desired[key],
  );

/** The body of an `updateImage` converging the image on the props (empty when in sync). */
const imageDelta = (
  image: iaas.Image,
  news: ImageProps,
  name: string,
  labels: Record<string, string>,
) => {
  const patch: Omit<iaas.UpdateImageRequest, "projectId" | "region" | "imageId"> = {};
  if (image.name !== name) patch.name = name;
  if (news.minDiskSize !== undefined && image.minDiskSize !== news.minDiskSize) {
    patch.minDiskSize = news.minDiskSize;
  }
  if (news.minRam !== undefined && image.minRam !== news.minRam) patch.minRam = news.minRam;
  if (news.protected !== undefined && image.protected !== news.protected) {
    patch.protected = news.protected;
  }
  // The observed fields go along, so the request is correct whether the API
  // merges or replaces the nested object.
  if (news.config !== undefined && drifted<iaas.ImageConfig>(image.config, news.config)) {
    patch.config = { ...image.config, ...news.config };
  }
  if (news.agent !== undefined && drifted<iaas.ImageAgent>(image.agent, news.agent)) {
    patch.agent = { ...image.agent, ...news.agent };
  }
  const labelPatch = labelsPatch(image.labels, labels);
  if (labelPatch !== undefined) patch.labels = labelPatch;
  return patch;
};

export const ImageProvider = () =>
  Provider.succeed(Image, {
    stables: ["imageId", "diskFormat", "projectId", "region"],

    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const scope = { projectId: env.projectId, region: env.region };
      const { items } = yield* iaas.listImages(scope);
      return ownedOnly(items)
        .filter((image) => image.status !== "DELETED")
        .map((image) =>
          toAttrs(image, scope, { fileSha512: undefined, sourceVolumeId: undefined }),
        );
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      if (hasUnresolvedTrigger<ImageProps>(news, ["projectId", "region", "diskFormat", "source"])) {
        return { action: "replace" } as const;
      }
      if (!isResolved(news)) return undefined;
      if (yield* projectScopeChanged(news, output)) return { action: "replace" } as const;
      if (news.diskFormat !== output.diskFormat) return { action: "replace" } as const;
      const source = news.source;
      const volume = source.type === "volume" ? source : undefined;
      const file = source.type === "file" ? yield* inspectFile(source.path) : undefined;
      return sameSource(output, volume, file) ? undefined : ({ action: "replace" } as const);
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output, previous }) {
      const scope = yield* resolveProjectScope(olds, output);
      const name = output?.name ?? (yield* iaasName(id, olds?.name));
      const generatedName = output === undefined && olds?.name === undefined;
      const observed = yield* observe({
        id,
        name,
        scope,
        imageId: output?.imageId,
        instanceId: readGeneration({ instanceId, output, previous }),
        generatedName,
      });
      if (observed === undefined) return undefined;
      const attrs = toAttrs(observed, scope, {
        fileSha512: output?.fileSha512,
        sourceVolumeId: output?.sourceVolumeId,
      });
      const owned =
        (generatedName && observed.name === name) || (yield* hasAlchemyLabels(id, observed.labels));
      return owned ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const name = yield* iaasName(id, news.name);
      const labels = yield* desiredGenerationLabels(id, instanceId, news.labels);
      const source = news.source;
      const volume = source.type === "volume" ? source : undefined;
      const file = source.type === "file" ? yield* inspectFile(source.path) : undefined;

      // Observe — a recorded image only counts for the same source.
      const recordedId =
        output !== undefined && sameSource(output, volume, file) ? output.imageId : undefined;
      let current = yield* observe({
        id,
        name,
        scope,
        imageId: recordedId,
        instanceId,
        generatedName: news.name === undefined,
      });

      // An image that can't become the desired one goes: a failed one, an
      // upload that never finished (its URL is handed out only once, so there
      // is no resuming it), or a recovered one holding other data.
      if (current?.id !== undefined) {
        const deleting = current.status === "DELETING";
        const unusable =
          deleting ||
          current.status === "ERROR" ||
          (file !== undefined &&
            (current.status === "CREATING" ||
              (current.id !== recordedId && !checksumMatches(current.checksum, file))));
        if (unusable) {
          yield* removeImage({ scope, imageId: current.id, name, deleting });
          current = undefined;
        }
      }

      // Ensure — create when missing.
      let imageId = current?.id;
      let uploaded = false;
      if (current === undefined) {
        if (volume !== undefined) {
          // `Conflict` while the volume is busy.
          const copied = yield* iaas
            .imageFromVolume({
              ...scope,
              volumeId: volume.volumeId,
              name,
              diskFormat: news.diskFormat,
              force: volume.force,
              protected: news.protected,
            })
            .pipe(Effect.retry(conflictRetry));
          imageId = copied.id;
        } else if (file !== undefined) {
          const created = yield* iaas.createImage({
            ...scope,
            name,
            diskFormat: news.diskFormat,
            labels,
            minDiskSize: news.minDiskSize,
            minRam: news.minRam,
            protected: news.protected,
            config: news.config,
            agent: news.agent,
          });
          yield* uploadFile({ uploadUrl: created.uploadUrl, file, resourceName: name });
          imageId = created.id;
          uploaded = true;
        }
      }
      if (imageId === undefined) {
        return yield* new ImageIdMissing({
          resourceName: name,
          message: `STACKIT returned image ${name} without an id`,
        });
      }
      const resolvedId = imageId;

      let observed =
        current !== undefined && isReady(current)
          ? current
          : yield* waitFor({
              resource: `STACKIT image ${name}`,
              read: iaas.getImage({ ...scope, imageId: resolvedId }),
              ready: isReady,
              failed: hasFailed,
              state: stateOf,
              timeout: READY_TIMEOUT,
              interval: "2 seconds",
              maxInterval: "15 seconds",
            });

      // Verify — a corrupted upload is removed, so the next deploy starts over
      // instead of recovering it.
      const checksum = observed.checksum;
      if (uploaded && file !== undefined && checksum !== undefined) {
        if (!checksumMatches(checksum, file)) {
          if (observed.protected === true) {
            yield* iaas.updateImage({ ...scope, imageId: resolvedId, protected: false });
          }
          yield* removeImage({ scope, imageId: resolvedId, name, deleting: false });
          const expected = checksumOf(checksum, file);
          return yield* new ImageChecksumMismatch({
            resourceName: name,
            algorithm: checksum.algorithm,
            expected,
            actual: checksum.digest,
            message: `STACKIT computed ${checksum.algorithm} ${checksum.digest} for image ${name}, but ${file.path} has ${expected}`,
          });
        }
      }

      // Sync — everything but the data, diffed against the observed image.
      const patch = imageDelta(observed, news, name, labels);
      if (Object.keys(patch).length > 0) {
        observed = yield* iaas.updateImage({ ...scope, imageId: resolvedId, ...patch });
      }
      return toAttrs({ ...observed, id: resolvedId }, scope, {
        fileSha512: file?.sha512,
        sourceVolumeId: volume?.volumeId,
      });
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* removeImage({
        scope: { projectId: output.projectId, region: output.region },
        imageId: output.imageId,
        name: output.name,
        deleting: false,
      });
    }),
  });
