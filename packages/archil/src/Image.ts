import * as BuildPlan from "@alchemy.run/docker/BuildPlan";
import type { InlineDockerfile } from "@alchemy.run/docker/Dockerfile";
import type { DockerfileBuild } from "@alchemy.run/docker/ImageSource";
import type { ImageRegistry } from "@alchemy.run/docker/Registry";
import * as archil from "@distilled.cloud/archil";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { waitForImage } from "./internal/archil.ts";
import type { Providers } from "./Providers.ts";

export interface ImageProps {
  /**
   * Linux OCI image reference with a `linux/amd64` manifest, e.g.
   * `ghcr.io/acme/agent:1`. Docker shorthand and tags are accepted.
   * Exclusive with `dockerfile` and `context`. Changing it builds a new
   * image.
   */
  image?: string;
  /**
   * A Dockerfile path (relative to the cwd) or `Dockerfile.inline` content.
   * Archil has no builder of its own: Alchemy builds it with your local
   * Docker and pushes it to `push.repository`, and Archil pulls it from
   * there.
   */
  dockerfile?: string | InlineDockerfile;
  /** Build context for a `dockerfile` path. */
  context?: string;
  /** Docker build args and BuildKit secrets for a `dockerfile` image. */
  build?: DockerfileBuild;
  /**
   * Credentials for a private registry. Archil uses them to pull this
   * image only and doesn't store them.
   */
  registry?: ImageRegistry;
  /**
   * Where a Dockerfile image is pushed for Archil to pull: a repository
   * (no tag; the build's hash is the tag) and credentials that can push to
   * it and pull from it. Required for `dockerfile` images.
   */
  push?: ImagePush;
}

/** A registry repository Alchemy pushes built images to, for Archil to pull. */
export interface ImagePush {
  /** Repository without a tag, e.g. `ghcr.io/acme/agent`. */
  repository: string;
  /** Credentials that can push to and pull from the repository. */
  credentials: ImageRegistry;
}

export interface ImageAttributes {
  /** Image id (64 hex characters); pass it as a sandbox's `image`. */
  imageId: string;
  /** The reference the image was built from. */
  source: string;
  /** The fully qualified reference Archil resolved, e.g. `docker.io/library/node:24`. */
  canonicalSource: string | undefined;
  /** Digest of the image sandboxes boot. */
  digest: string | undefined;
  /** Whether the image came from a private registry. */
  private: boolean;
  /** Hash of the build plan the image came from. */
  hash: string;
}

export type Image = Resource<
  "Archil.Image",
  ImageProps,
  ImageAttributes,
  never,
  Providers,
  ImageLookup
>;

/**
 * Props for {@link Image.lookup}: find an image this stack
 * doesn't manage by its id.
 */
export interface ImageLookup {
  /** Archil image id. */
  imageId: string;
}

/**
 * The image needs instructions run on top of its base, and Archil only
 * pulls finished images.
 */
export class ImageRequiresBuild extends Data.TaggedError("Archil.ImageRequiresBuild")<{
  readonly message: string;
}> {}

/**
 * A sandbox image. Archil pulls it from a public or private registry and
 * sandboxes boot its current digest. Public images can also be used
 * directly as a sandbox's `baseImage`; build an `Image` for a private one,
 * or to pin the digest every sandbox boots.
 *
 * Props follow `@alchemy.run/docker`'s image source, like every Alchemy
 * image resource. Archil has no builder, so a Dockerfile is built with
 * your local Docker and pushed to `push.repository`, and Archil pulls it
 * from there.
 *
 * Archil has no API to delete an image, so destroying the resource only
 * removes it from Alchemy's state.
 * @see https://docs.archil.com/api-reference/images/build-image
 *
 * ### Building an Image
 * **Example:** From a public image
 * ```typescript
 * export const Base = Archil.Image("Base", { image: "node:24-bookworm" });
 * ```
 *
 * **Example:** From a private registry
 * ```typescript
 * export const Agent = Archil.Image("Agent", {
 *   image: "ghcr.io/acme/agent:1",
 *   registry: {
 *     server: "ghcr.io",
 *     username: "acme-bot",
 *     password: Alchemy.Secret("GHCR_TOKEN"),
 *   },
 * });
 * ```
 *
 * **Example:** Build a Dockerfile and push it for Archil to pull
 * ```typescript
 * export const Agent = Archil.Image("Agent", {
 *   dockerfile: "./agent/Dockerfile",
 *   context: "./agent",
 *   push: {
 *     repository: "ghcr.io/acme/agent",
 *     credentials: { server: "ghcr.io", username: "acme-bot", password: Alchemy.Secret("GHCR_TOKEN") },
 *   },
 * });
 * ```
 *
 * ### Booting Sandboxes from an Image
 * **Example:** Sandboxes created at run time
 * ```typescript
 * const sandboxes = yield* Archil.CreateSandbox(Agent);
 * const sandbox = yield* sandboxes.create({ name: "task-1" });
 * ```
 *
 * ### Looking up an existing image
 * `Image.lookup` references an image Alchemy doesn't manage (created in
 * the Archil console or by another stack). It is read during plan/deploy,
 * never created, updated or deleted.
 * `hash` is empty: the image wasn't built by this stack.
 *
 * **Example:** Reference an existing image
 * ```typescript
 * const base = Archil.Image.lookup({ imageId: "img_123" });
 * ```
 *
 * @resource
 * @product Image
 */
export const Image = Resource<Image>("Archil.Image");

/** What Archil's image service can build: nothing beyond pulling a reference. */
export const capabilities: BuildPlan.Capabilities = {
  target: "Archil.Image",
  platforms: ["linux/amd64"],
};

/** Map an image response to attributes. */
export const toImageAttributes = (
  image: archil.Image,
  hash: string,
  source: string = image.source,
): ImageAttributes => ({
  imageId: image.image_id,
  // Archil may answer with a reference it normalized (or one an earlier
  // build of the same image used), so keep the one that was asked for.
  source,
  canonicalSource: image.canonical_source,
  digest: image.digest,
  private: image.private,
  hash,
});

/** Plan an image source for Archil. */
export const planImage = (props: ImageProps) =>
  BuildPlan.plan(
    props.image !== undefined
      ? { image: props.image }
      : { dockerfile: props.dockerfile, context: props.context, build: props.build },
    { capabilities, pull: props.registry },
  );

/**
 * The reference Archil can pull for a plan: its base, when the plan adds
 * nothing on top of it.
 */
export const pullableSource = (plan: BuildPlan.BuildPlan) =>
  plan.instructions.length === 0 && plan.files.length === 0
    ? Effect.succeed(plan.base)
    : Effect.fail(
        new ImageRequiresBuild({
          message: `Archil.Image pulls finished images; this Dockerfile adds ${plan.instructions.length} instruction(s) on top of ${plan.base}. Set \`push: { repository, credentials }\` so Alchemy can build it and push it there.`,
        }),
      );

/** Ask Archil to pull a reference and wait until the image is ready. */
export const pullImage = Effect.fn(function* (
  source: string,
  registry: ImageRegistry | undefined,
  hash: string,
) {
  const { data } = yield* archil.createImage({
    source,
    registry_auth: registry
      ? { username: registry.username, password: registry.password }
      : undefined,
  });
  return toImageAttributes(yield* waitForImage(data.image_id), hash, source);
});

/**
 * The reference Archil pulls for a plan: its base when the plan adds
 * nothing, else the plan built locally and pushed to `push`.
 */
export const publishPlan = Effect.fn(function* (
  plan: BuildPlan.BuildPlan,
  push: ImagePush | undefined,
) {
  if (plan.instructions.length === 0 && plan.files.length === 0) {
    return { source: plan.base, credentials: undefined };
  }
  if (push === undefined) {
    return yield* new ImageRequiresBuild({
      message: `Archil.Image pulls finished images; this Dockerfile adds ${plan.instructions.length} instruction(s) on top of ${plan.base}. Set \`push: { repository, credentials }\` so Alchemy can build it and push it there.`,
    });
  }
  const { imageRef } = yield* Effect.scoped(
    BuildPlan.push(plan, { repository: push.repository, push: push.credentials }),
  );
  return { source: imageRef, credentials: push.credentials };
});

/** Plan, publish, then pull, an image. */
export const buildImage = Effect.fn(function* (props: ImageProps) {
  const plan = yield* planImage(props);
  const published = yield* publishPlan(plan, props.push);
  return yield* pullImage(published.source, published.credentials ?? props.registry, plan.hash);
});

export const ImageProvider = () =>
  Provider.effect(
    Image,
    Effect.gen(function* () {
      return {
        stables: ["imageId"],
        // No delete or list API: nuke can't remove images.
        nuke: { skip: true },
        diff: Effect.fn(function* ({ news, output }) {
          if (!isResolved(news) || output === undefined) return undefined;
          // The plan hash covers the reference, the Dockerfile and its context.
          const plan = yield* planImage(news);
          if (plan.hash !== output.hash) return { action: "replace" } as const;
          return undefined;
        }),
        lookup: Effect.fn(function* ({ imageId }) {
          return yield* archil.getImage({ image_id: imageId }).pipe(
            Effect.map(({ data }) => toImageAttributes(data, "")),
            Effect.catchTag("NotFound", () => Effect.undefined),
          );
        }),

        read: Effect.fn(function* ({ output }) {
          if (!output) return undefined;
          return yield* archil.getImage({ image_id: output.imageId }).pipe(
            Effect.map(({ data }) => toImageAttributes(data, output.hash, output.source)),
            Effect.catchTag("NotFound", () => Effect.undefined),
          );
        }),
        reconcile: Effect.fn(function* ({ news, output, session }) {
          const plan = yield* planImage(news);
          for (const warning of plan.warnings) yield* session.note(warning);
          // Observe — a ready image from the same plan is kept; anything
          // else (missing, failed, interrupted) is requested again.
          if (output && output.hash === plan.hash) {
            const observed = yield* archil.getImage({ image_id: output.imageId }).pipe(
              Effect.map(({ data }) => data),
              Effect.catchTag("NotFound", () => Effect.undefined),
            );
            if (observed?.status === "ready")
              return toImageAttributes(observed, plan.hash, output.source);
            if (observed?.status === "building") {
              return toImageAttributes(
                yield* waitForImage(observed.image_id),
                plan.hash,
                output.source,
              );
            }
          }
          // Ensure
          if (plan.instructions.length > 0 || plan.files.length > 0) {
            yield* session.note(`Building and pushing image to ${news.push?.repository}...`);
          }
          const published = yield* publishPlan(plan, news.push);
          yield* session.note(`Pulling image ${published.source}...`);
          return yield* pullImage(
            published.source,
            published.credentials ?? news.registry,
            plan.hash,
          );
        }),
        // Archil has no image delete API.
        delete: () => Effect.void,
      };
    }),
  );
