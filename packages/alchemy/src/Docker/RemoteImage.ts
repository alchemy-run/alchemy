import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { deepEqual, isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import * as ProviderLayer from "../Local/ProviderLayer.ts";
import { Resource } from "../Resource.ts";
import type { InputProps, PropsInput } from "../Input.ts";
import { sha256Object } from "../Util/sha256.ts";
import { Docker, dockerContextName } from "./Docker.ts";
import {
  ImagePublication,
  ImagePublicationLive,
  retryImagePublication,
} from "./ImagePublication.ts";
import {
  findImageManifest,
  parseImageReference,
  resolveImageManifest,
  resolveRegistryCredentials,
  syncImageTags,
  validateImageRepository,
  type ImagePublish,
} from "./ImageRegistry.ts";
import type { Providers } from "./Providers.ts";
import {
  type ImageRegistry,
  parseCreatedAt,
  repositoryFromImageRef,
  withRegistryHost,
} from "./Registry.ts";

interface RemoteImageSettings {
  /** Pull or mirror this platform. */
  platform?: string;
  /** Publication destination. Omit to make the image available locally. */
  publish?: ImagePublish;
  /** Docker daemon context name or resource. */
  dockerContext?: Docker.ContextRef;
  /** Refresh mutable source tags. @default true */
  alwaysPull?: boolean;
  /** Docker daemon context. @deprecated Use `dockerContext`. */
  context?: Docker.ContextRef;
}

export type RemoteImageProps = RemoteImageSettings &
  (
    | {
        /** Complete source image reference, including a tag or digest. */
        source: string;
        name?: never;
        tag?: never;
        targetName?: never;
        targetTag?: never;
        registry?: never;
        skipPush?: never;
      }
    | {
        source?: never;
        /** Source repository. @deprecated Use a complete `source` reference. */
        name: string;
        /** Source tag. @deprecated Include the tag in `source`. */
        tag?: string;
        /** Destination repository. @deprecated Use `publish.repository`. */
        targetName?: string;
        /** Destination tag. @deprecated Use `publish.tags`. */
        targetTag?: string;
        /** Destination credentials. @deprecated Use `publish`. */
        registry?: ImageRegistry;
        /** Suppress legacy publication. @deprecated Omit `publish`. */
        skipPush?: boolean;
      }
  );

/** Source and publication options for an unnamed remote image. */
export interface RemoteImageOptions extends Omit<
  RemoteImageSettings,
  "context"
> {
  /** Complete source image reference, including a tag or digest. */
  source: string;
}

/** Plain image data; the consuming resource registers the actual Docker.RemoteImage. */
export interface RemoteImageSource extends RemoteImageOptions {
  readonly _tag: "Docker.RemoteImage";
}

export const isRemoteImageSource = (
  value: unknown,
): value is RemoteImageSource =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  value._tag === "Docker.RemoteImage";

const RemoteImageResource = Resource<RemoteImage>("Docker.RemoteImage");

function remoteImage(
  options: InputProps<RemoteImageOptions>,
): InputProps<RemoteImageOptions> & { readonly _tag: "Docker.RemoteImage" };
function remoteImage(
  id: string,
  props: PropsInput<RemoteImageProps>,
): Effect.Effect<RemoteImage, never, Providers>;
function remoteImage<R>(
  id: string,
  props: Effect.Effect<InputProps<RemoteImageProps>, never, R>,
): Effect.Effect<RemoteImage, never, R | Providers>;
function remoteImage<R>(
  idOrOptions: string | InputProps<RemoteImageOptions>,
  props?:
    | PropsInput<RemoteImageProps>
    | Effect.Effect<InputProps<RemoteImageProps>, never, R>,
) {
  if (typeof idOrOptions !== "string")
    return { ...idOrOptions, _tag: "Docker.RemoteImage" as const };
  return Effect.isEffect(props)
    ? RemoteImageResource(idOrOptions, props)
    : RemoteImageResource(idOrOptions, props!);
}

export interface RemoteImage extends Resource<
  "Docker.RemoteImage",
  RemoteImageProps,
  {
    /** Immutable image reference suitable for a container. */
    ref: string;
    /** Source manifest digest used for this image. */
    sourceDigest?: string;
    /** Effective source and platform hash. */
    hash?: string;
    /** Legacy image reference. Prefer `ref` for immutable deployments. */
    imageRef: string;
    /** Local image id, absent for registry-only resolution. */
    imageId?: string;
    /** Docker creation time when a local image was inspected. */
    createdAt?: number;
    /** Final repository/name. */
    name: string;
    /** Publication or local alias tag. */
    tag: string;
    /** Immutable registry reference, when published. */
    repoDigest?: string;
  },
  never,
  Providers
> {}

/**
 * Resolves an existing image and optionally mirrors it into another registry.
 * Mutable source tags are checked against the registry. Images already in the
 * destination repository are used without a Docker pull or push. Registry
 * artifacts and source images are retained when this resource is destroyed.
 *
 * ### Unnamed Images
 * **Example:** Let a container own the remote image resource
 * ```typescript
 * const container = yield* Cloudflare.Container("Web", {
 *   image: Docker.RemoteImage({ source: "nginx:alpine" }),
 * }).Application;
 * ```
 *
 * The no-ID overload returns plain `RemoteImageSource` data. The consuming
 * platform registers a child resource; the helper itself never pulls,
 * publishes, or registers anything.
 *
 * ### Local Images
 * **Example:** Pull an existing image
 * ```typescript
 * const nginx = yield* Docker.RemoteImage("Nginx", {
 *   source: "docker.io/library/nginx:alpine",
 * });
 * ```
 *
 * ### Mirroring Images
 * **Example:** Publish into a private repository
 * ```typescript
 * const nginx = yield* Docker.RemoteImage("Nginx", {
 *   source: "docker.io/library/nginx:alpine",
 *   publish: { repository: "registry.example.com/team/nginx" },
 * });
 * ```
 *
 * @resource
 */
export const RemoteImage: typeof remoteImage &
  Omit<typeof RemoteImageResource, never> = Object.assign(remoteImage, {
  ...RemoteImageResource,
});

const sourceOf = (props: RemoteImageProps) =>
  props.source ?? `${props.name}:${props.tag ?? "latest"}`;
const localRefOf = (props: RemoteImageProps) =>
  props.source ??
  `${props.targetName ?? props.name}:${props.targetTag ?? props.tag ?? "latest"}`;
const publishOf = (props: RemoteImageProps): ImagePublish | undefined =>
  props.publish ??
  (props.registry && !props.skipPush
    ? {
        repository: withRegistryHost(
          props.targetName ?? props.name,
          props.registry,
        ),
        tags: [props.targetTag ?? props.tag ?? "latest"],
        credentials: {
          username: props.registry.username,
          password: props.registry.password,
        },
      }
    : undefined);

const effectivePlatform = (props: RemoteImageProps) =>
  Effect.sync(
    () =>
      props.platform ?? `linux/${process.arch === "arm64" ? "arm64" : "amd64"}`,
  );

export const RemoteImageProvider = () =>
  ProviderLayer.dual(RemoteImage, {
    live: () => makeRemoteImageProvider(false),
    local: () => makeRemoteImageProvider(true),
  });

const makeRemoteImageProvider = (localMode: boolean) =>
  Provider.effect(
    RemoteImage,
    Effect.gen(function* () {
      const docker = yield* Docker;
      const publication = yield* ImagePublication;
      const local = (ref: string, context?: string) =>
        docker.image
          .inspect(ref, context)
          .pipe(
            Effect.catchReason(
              "PlatformError",
              "NotFound",
              () => Effect.undefined,
            ),
          );
      const observeSource = Effect.fn(function* (props: RemoteImageProps) {
        const source = sourceOf(props);
        if (source.startsWith("sha256:")) {
          const image = yield* docker.image.inspect(
            source,
            dockerContextName(props.dockerContext ?? props.context),
          );
          return { ref: source, digest: image.Id, credentials: undefined };
        }
        const credentials = yield* resolveRegistryCredentials(
          parseImageReference(source).server,
          ["pull"],
        );
        return {
          ...(yield* resolveImageManifest(source, credentials)),
          credentials,
        };
      });

      return RemoteImage.Provider.of({
        list: () => Effect.succeed([]),
        read: Effect.fn(function* ({ olds, output }) {
          const publish = localMode ? undefined : publishOf(olds);
          if (publish) {
            const reference =
              output?.repoDigest ?? output?.ref ?? output?.imageRef;
            if (!reference) return undefined;
            const credentials = yield* resolveRegistryCredentials(
              parseImageReference(publish.repository).server,
              ["pull"],
              publish.credentials,
            );
            const image = yield* findImageManifest(reference, credentials);
            if (!image) return undefined;
            return {
              ...output,
              ref: image.ref,
              imageRef: output?.imageRef ?? image.ref,
              repoDigest: image.ref,
              name: repositoryFromImageRef(image.ref),
              tag: output?.tag ?? parseImageReference(sourceOf(olds)).selector,
            };
          }
          const ref = output?.imageRef ?? localRefOf(olds);
          const image = yield* local(
            ref,
            dockerContextName(olds.dockerContext ?? olds.context),
          );
          if (!image) return undefined;
          return {
            ...output,
            ref: image.Id,
            imageRef: ref,
            imageId: image.Id,
            createdAt: parseCreatedAt(image.Created),
            name: repositoryFromImageRef(ref),
            tag: olds.targetTag ?? parseImageReference(ref).selector,
          };
        }),
        diff: Effect.fn(function* ({ output, news, olds }) {
          if (!isResolved(news)) return undefined;
          if (
            !output ||
            dockerContextName(news.dockerContext ?? news.context) !==
              dockerContextName(olds.dockerContext ?? olds.context) ||
            !deepEqual(publishOf(news), publishOf(olds)) ||
            sourceOf(news) !== sourceOf(olds)
          )
            return { action: "update" };
          const publish = localMode ? undefined : publishOf(news);
          if (publish) {
            const credentials = yield* resolveRegistryCredentials(
              parseImageReference(publish.repository).server,
              ["pull"],
              publish.credentials,
            );
            if (!(yield* findImageManifest(output.ref, credentials)))
              return { action: "update" };
          }
          // Preserve legacy alwaysPull behavior while migrating existing callers.
          if (news.source === undefined)
            return news.alwaysPull !== false ? { action: "update" } : undefined;
          const platform = yield* effectivePlatform(news);
          const sourceDigest =
            news.alwaysPull === false
              ? output.sourceDigest
              : (yield* observeSource(news)).digest;
          const hash = yield* sha256Object({ source: sourceDigest, platform });
          if (hash !== output.hash) return { action: "update" };
        }),
        reconcile: Effect.fn(function* ({ news, session }) {
          if (news.context && news.dockerContext)
            return yield* Effect.fail(
              new Error(
                "Declare dockerContext, not both context and dockerContext",
              ),
            );
          if (
            news.publish &&
            (news.registry ||
              news.targetName ||
              news.targetTag ||
              news.skipPush !== undefined)
          )
            return yield* Effect.fail(
              new Error("Use publish without legacy destination options"),
            );
          const context = dockerContextName(news.dockerContext ?? news.context);
          const source = yield* observeSource(news);
          const requestedPublish = publishOf(news);
          if (requestedPublish)
            yield* validateImageRepository(requestedPublish.repository);
          const publish = localMode ? undefined : requestedPublish;
          const platform = yield* effectivePlatform(news);
          const hash = yield* sha256Object({ source: source.digest, platform });
          if (publish) {
            const target = yield* validateImageRepository(publish.repository);
            const credentials = yield* resolveRegistryCredentials(
              target.server,
              ["pull", "push"],
              publish.credentials,
            );
            const inputRef = `${target.repository}:${hash}`;
            const result =
              parseImageReference(source.ref).repository === target.repository
                ? source
                : yield* publication.withLock(
                    inputRef,
                    Effect.gen(function* () {
                      const cached = yield* findImageManifest(
                        inputRef,
                        credentials,
                      );
                      if (cached) return cached;
                      yield* session.note(`Mirroring image ${source.ref}`);
                      if (!source.ref.startsWith("sha256:"))
                        yield* docker.image.pull(
                          source.ref,
                          platform,
                          context,
                          source.credentials,
                        );
                      yield* docker.image.tag(source.ref, inputRef, context);
                      yield* docker.image
                        .push(
                          inputRef,
                          credentials ?? { server: target.server },
                          platform,
                          context,
                        )
                        .pipe(retryImagePublication);
                      return yield* resolveImageManifest(inputRef, credentials);
                    }),
                  );
            yield* syncImageTags(
              result.ref,
              [hash, ...(publish.tags ?? [])],
              credentials,
            );
            return {
              ref: result.ref,
              imageRef: news.registry
                ? `${target.repository}:${news.targetTag ?? news.tag ?? "latest"}`
                : result.ref,
              repoDigest: result.ref,
              name: target.repository,
              tag: news.targetTag ?? news.tag ?? hash,
              sourceDigest: source.digest,
              hash,
            };
          }
          if (!source.ref.startsWith("sha256:")) {
            yield* session.note(`Pulling image ${source.ref}`);
            yield* docker.image.pull(
              source.ref,
              platform,
              context,
              source.credentials,
            );
          }
          const alias = localRefOf(news);
          if (alias !== source.ref)
            yield* docker.image.tag(source.ref, alias, context);
          const image = yield* docker.image.inspect(source.ref, context);
          return {
            ref: image.Id,
            imageRef: alias,
            imageId: image.Id,
            name: repositoryFromImageRef(alias),
            tag: news.targetTag ?? parseImageReference(alias).selector,
            createdAt: parseCreatedAt(image.Created),
            sourceDigest: source.digest,
            hash,
          };
        }),
        delete: () => Effect.void,
      });
    }),
  ).pipe(Layer.provide(ImagePublicationLive));
