import * as DO from "@distilled.cloud/digitalocean";
import type { Image as ApiImage, ImageStatus } from "@distilled.cloud/digitalocean";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { ignoreNotFound, noneIfNotFound } from "./internal/notFound.ts";
import { withoutAlchemyTags } from "./internal/ownership.ts";
import { pollUntil, type PollBudget } from "./internal/poll.ts";
import type { Providers } from "./Providers.ts";
import type { RegionSlug } from "./Slugs.ts";

export type ImageProps = {
  /**
   * Display name. A change renames the image in place.
   *
   * @default a generated physical name
   */
  name?: string;
  /**
   * URL of a raw, qcow2, VHDX, VDI or VMDK image (optionally gzip- or
   * bzip2-compressed) that DigitalOcean downloads. A change replaces the
   * image.
   */
  url: string;
  /** Region the image is stored in first. A change replaces the image. */
  region: RegionSlug;
  /** Distribution shown in the control panel, for example `"Ubuntu"`. */
  distribution?: string;
  /** Free-form description. */
  description?: string;
  /** Tags to assign at import. A change replaces the image. */
  tags?: string[];
};

export type Image = Resource<
  "DigitalOcean.Image",
  ImageProps,
  {
    /** Numeric image id; pass it as a droplet's `image`. */
    imageId: number;
    /** Display name. */
    name: string;
    /** `available` once usable. */
    status: ImageStatus;
    /** Regions the image is stored in. */
    regions: string[];
    /** Smallest disk, in GB, that can run the image. */
    minDiskSize: number | undefined;
    /** Tags without the `alchemy:` tags. */
    tags: string[];
    /** ISO 8601 creation time. */
    createdAt: string;
  },
  never,
  Providers
>;

export type ImageAttributes = Image["Attributes"];

/**
 * A DigitalOcean custom image imported from a URL, to boot droplets from
 * your own OS build. Import takes a few minutes; `reconcile` returns once
 * the image is `available`. `name`, `distribution` and `description`
 * update in place; `url`, `region` and `tags` replace the image.
 *
 * Alchemy knows an image by the id it recorded, or by the name it
 * generated when an import was interrupted before the id was saved.
 *
 * ### Importing an Image
 * **Example:** Boot a droplet from a custom image
 * ```typescript
 * const image = yield* DigitalOcean.Image("debian", {
 *   url: "https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-generic-amd64.qcow2",
 *   region: "nyc3",
 *   distribution: "Debian",
 * });
 * const host = yield* DigitalOcean.Droplet("app", {
 *   region: "nyc3",
 *   size: "s-1vcpu-1gb",
 *   image: image.imageId,
 * });
 * ```
 *
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#operation/images_create_custom
 *
 * @resource
 * @product Images
 * @category Compute
 */
export const Image = Resource<Image>("DigitalOcean.Image");

export class ImageImportFailed extends Data.TaggedError("DigitalOcean.ImageImportFailed")<{
  readonly imageId: number;
  readonly reason: string;
}> {
  override get message() {
    return `Image ${this.imageId} did not import: ${this.reason}.`;
  }
}

// Importing a few hundred MB takes two to ten minutes (≈ 15 min budget).
const IMPORT_POLL: PollBudget = { maxDelay: "15 seconds", times: 64 };

const physicalName = (id: string) => createPhysicalName({ id, maxLength: 255 });

const toAttrs = (image: ApiImage): ImageAttributes => ({
  imageId: image.id,
  name: image.name,
  status: image.status,
  regions: [...image.regions],
  minDiskSize: image.min_disk_size ?? undefined,
  tags: withoutAlchemyTags(image.tags ?? []),
  createdAt: image.created_at,
});

const observeByName = (name: string) =>
  DO.listImages.items({ private: true, per_page: 200 }).pipe(
    Stream.filter((image) => image.name === name),
    Stream.runHead,
  );

// The stored id is a cache; a generated name finds an image whose create
// was interrupted before its id was saved.
const observeOwned = Effect.fn(function* (
  imageId: number | undefined,
  generatedName: string | undefined,
) {
  if (imageId !== undefined) {
    const byId = yield* observe(imageId);
    if (Option.isSome(byId)) return byId;
  }
  if (generatedName === undefined) return Option.none<ApiImage>();
  return yield* observeByName(generatedName);
});

const observe = (imageId: number) =>
  noneIfNotFound(DO.getImage({ image_id: String(imageId) }).pipe(Effect.map((r) => r.image)));

const waitUntilAvailable = (imageId: number) =>
  pollUntil(observe(imageId), {
    ...IMPORT_POLL,
    until: (o): o is Option.Some<ApiImage> =>
      // A pending import reports an empty error message.
      Option.isSome(o) && (o.value.status === "available" || !!o.value.error_message),
    onTimeout: () =>
      new ImageImportFailed({ imageId, reason: "the import did not finish in time" }),
  }).pipe(
    Effect.flatMap(({ value }) =>
      value.status === "available"
        ? Effect.succeed(value)
        : Effect.fail(new ImageImportFailed({ imageId, reason: value.error_message || "error" })),
    ),
  );

export const ImageProvider = () =>
  Provider.succeed(Image, {
    stables: ["imageId", "createdAt"],
    nuke: { skip: true },
    read: Effect.fn(function* ({ id, olds, output }) {
      const generatedName = olds.name === undefined ? yield* physicalName(id) : undefined;
      const observed = yield* observeOwned(output?.imageId, generatedName);
      return Option.getOrUndefined(Option.map(observed, toAttrs));
    }),
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      const tagsChanged = (news.tags ?? []).join("\0") !== (olds.tags ?? []).join("\0");
      if (news.url !== olds.url || news.region !== olds.region || tagsChanged) {
        return { action: "replace" } as const;
      }
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const name = news.name ?? (yield* physicalName(id));
      const generatedName = news.name === undefined ? name : undefined;
      const observed = yield* observeOwned(output?.imageId, generatedName);
      const image = yield* Option.match(observed, {
        onNone: () =>
          DO.createImageCustom({
            name,
            url: news.url,
            region: news.region,
            distribution: news.distribution,
            description: news.description,
            tags: news.tags,
          }).pipe(Effect.map((r) => r.image)),
        onSome: Effect.succeed,
      });
      const ready = yield* waitUntilAvailable(image.id);
      const inSync =
        ready.name === name &&
        (ready.description ?? "") === (news.description ?? "") &&
        (news.distribution === undefined || ready.distribution === news.distribution);
      if (inSync) return toAttrs(ready);
      const updated = yield* DO.updateImage({
        image_id: ready.id,
        name,
        description: news.description ?? "",
        distribution: news.distribution,
      });
      return toAttrs(updated.image);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(DO.deleteImage({ image_id: output.imageId }));
    }),
  });
