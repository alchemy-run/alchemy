import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { deepEqual, isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import * as ProviderLayer from "../Local/ProviderLayer.ts";
import { Resource } from "../Resource.ts";
import { Docker, dockerContextName, dockerPhysicalName } from "./Docker.ts";
import { prepareImageBuild, type DockerBuildOptions } from "./ImageBuild.ts";
import {
  ImagePublication,
  ImagePublicationLive,
  retryImagePublication,
} from "./ImagePublication.ts";
import {
  findImageManifest,
  parseImageReference,
  resolveRegistryCredentials,
  syncImageTags,
  validateImageRepository,
  type ImagePublish,
} from "./ImageRegistry.ts";
import type { Providers } from "./Providers.ts";
import { ensureLocalImage, type LocalImageBuild } from "./LocalImage.ts";
import {
  type ImageRegistry,
  parseCreatedAt,
  repositoryFromImageRef,
  withRegistryHost,
} from "./Registry.ts";

export type { DockerBuildOptions } from "./ImageBuild.ts";
export type { ImagePublish } from "./ImageRegistry.ts";

export interface ImageProps {
  /** Docker build configuration. */
  build: DockerBuildOptions;
  /** Publication destination. Omit to build only in the selected Docker daemon. */
  publish?: ImagePublish;
  /** Docker daemon context name or context resource. */
  dockerContext?: Docker.ContextRef;
  /** Local repository name. @deprecated Prefer generated local identity or `publish.repository`. */
  name?: string;
  /** Additional local/publication tag. @deprecated Use `publish.tags` for publication aliases. */
  tag?: string;
  /** Registry credentials. @deprecated Use `publish` instead. */
  registry?: ImageRegistry;
  /** Suppress legacy publication. @deprecated Omit `publish` for local builds. */
  skipPush?: boolean;
  /** Docker daemon context. @deprecated Use `dockerContext`. */
  context?: Docker.ContextRef;
}

export interface Image extends Resource<
  "Docker.Image",
  ImageProps,
  {
    /** Immutable image reference suitable for a container. */
    ref: string;
    /** @internal Local build descriptor consumed by development runtimes. */
    localBuild?: LocalImageBuild;
    /** Hash of the effective build inputs. */
    hash?: string;
    /** Image repository without tag. */
    name: string;
    /** Image reference. @deprecated Use `ref` for immutable deployments. */
    imageRef: string;
    /** Local image id, absent when publication does not load a local image. */
    imageId?: string;
    /** Immutable registry reference, when published. */
    repoDigest?: string;
    /** Managed input tag, or the legacy explicit tag. */
    tag: string;
    /** Docker creation timestamp, available only for locally inspected images. */
    builtAt?: number;
  },
  never,
  Providers
> {}

/**
 * Builds a Docker image and optionally publishes it to a registry. Published
 * builds are reused by their input hash without requiring a Docker builder.
 * Registry artifacts are retained on destroy because other deployments may
 * still consume them. Pin base images and downloaded dependencies; changes
 * outside the build context require explicit invalidation with `build.extraHash`.
 *
 * ### Unnamed Images
 * **Example:** Let a container own the image resource
 * ```typescript
 * const container = yield* Cloudflare.Container("Web", {
 *   image: { context: "./web", publish: { repository: "web" } },
 * }).Application;
 * ```
 *
 * Embedded `ImageOptions` are plain objects. The consuming platform registers
 * a child image resource and resolves relative publication repositories.
 * Use the named resource below when explicitly sharing an image.
 *
 * ### Local Images
 * **Example:** Build in the selected Docker daemon
 * ```typescript
 * const image = yield* Docker.Image("WebImage", {
 *   build: { context: "./web" },
 * });
 * const container = yield* Docker.Container("Web", { image: image.ref });
 * ```
 *
 * ### Published Images
 * **Example:** Share a published image between deployments
 * ```typescript
 * const image = yield* Docker.Image("WebImage", {
 *   build: { context: "./web", platform: "linux/amd64" },
 *   publish: { repository: "registry.example.com/team/web" },
 * });
 * ```
 *
 * ### Inline Dockerfiles
 * **Example:** Build an inline Dockerfile
 * ```typescript
 * const image = yield* Docker.Image("Base", {
 *   build: { dockerfile: Dockerfile.inline`FROM alpine:3.22` },
 * });
 * ```
 *
 * @resource
 */
export const Image = Resource<Image>("Docker.Image");

export const ImageProvider = () =>
  ProviderLayer.dual(Image, {
    live: () => makeImageProvider(false),
    local: () => makeImageProvider(true),
  });

const makeImageProvider = (localMode: boolean) =>
  Provider.effect(
    Image,
    Effect.gen(function* () {
      const docker = yield* Docker;
      const publication = yield* ImagePublication;

      const location = Effect.fn(function* (
        id: string,
        props: ImageProps,
        instanceId: string,
      ) {
        if (
          props.publish &&
          (props.registry ||
            props.skipPush !== undefined ||
            props.name ||
            props.tag)
        ) {
          return yield* Effect.fail(
            new Error(
              "Use publish.repository/tags instead of combining publish with legacy image naming or registry options",
            ),
          );
        }
        if (props.context && props.dockerContext)
          return yield* Effect.fail(
            new Error(
              "Declare dockerContext, not both context and dockerContext",
            ),
          );
        const localName = yield* dockerPhysicalName(id, props, instanceId);
        const requestedPublish =
          props.publish ??
          (props.registry && !props.skipPush
            ? {
                repository: withRegistryHost(localName, props.registry),
                tags: [props.tag ?? "latest"],
                credentials: {
                  username: props.registry.username,
                  password: props.registry.password,
                },
              }
            : undefined);
        if (requestedPublish)
          yield* validateImageRepository(requestedPublish.repository);
        const publish = localMode ? undefined : requestedPublish;
        return {
          name: publish?.repository ?? localName,
          publish,
          context: dockerContextName(props.dockerContext ?? props.context),
        };
      });

      const observeLocal = (ref: string, context: string | undefined) =>
        docker.image
          .inspect(ref, context)
          .pipe(
            Effect.catchReason(
              "PlatformError",
              "NotFound",
              () => Effect.undefined,
            ),
          );

      return Image.Provider.of({
        list: () => Effect.succeed([]),
        read: Effect.fn(function* ({ id, instanceId, olds, output }) {
          const target = yield* location(id, olds, instanceId);
          if (target.publish) {
            const credentials = yield* resolveRegistryCredentials(
              parseImageReference(target.name).server,
              ["pull"],
              target.publish.credentials,
            );
            const reference =
              output?.repoDigest ?? output?.ref ?? output?.imageRef;
            if (!reference) return undefined;
            const manifest = yield* findImageManifest(reference, credentials);
            if (!manifest) return undefined;
            return {
              ...output,
              ref: manifest.ref,
              name: repositoryFromImageRef(manifest.ref),
              imageRef: output?.imageRef ?? manifest.ref,
              repoDigest: manifest.ref,
              hash: output?.hash,
              tag: output?.tag ?? olds.tag ?? "latest",
            };
          }
          const imageRef =
            output?.imageRef ?? `${target.name}:${olds.tag ?? "latest"}`;
          const image = yield* observeLocal(imageRef, target.context);
          if (!image) return undefined;
          return {
            ref: image.Id,
            name: target.name,
            imageRef,
            imageId: image.Id,
            localBuild: output?.localBuild,
            hash: image.Id === output?.imageId ? output.hash : undefined,
            tag: output?.tag ?? olds.tag ?? "latest",
            builtAt: parseCreatedAt(image.Created),
          };
        }),
        diff: Effect.fn(function* ({ id, instanceId, news, output, olds }) {
          if (!isResolved(news) || !output) return undefined;
          const [target, previous, build] = yield* Effect.all([
            location(id, news, instanceId),
            location(id, olds, instanceId),
            prepareImageBuild(news.build),
          ]);
          if (
            output.hash !== build.hash ||
            target.name !== previous.name ||
            target.context !== previous.context ||
            !deepEqual(target.publish, previous.publish)
          ) {
            return { action: "update" };
          }
          if (target.publish) {
            const credentials = yield* resolveRegistryCredentials(
              parseImageReference(target.name).server,
              ["pull"],
              target.publish.credentials,
            );
            if (!(yield* findImageManifest(output.ref, credentials)))
              return { action: "update" };
          }
        }),
        reconcile: Effect.fn(function* ({ id, instanceId, news, session }) {
          const target = yield* location(id, news, instanceId);
          const build = yield* prepareImageBuild(news.build);
          const tag = build.hash;
          const inputRef = `${target.name}:${tag}`;
          const options = {
            context: build.context,
            file: build.dockerfile,
            platform: build.platform,
            target: news.build.target,
            "build-arg": news.build.args,
            args: news.build.options,
            engineContext: target.context,
          };
          if (target.publish) {
            const publish = target.publish;
            const server = parseImageReference(target.name).server;
            const credentials = yield* resolveRegistryCredentials(
              server,
              ["pull", "push"],
              publish.credentials,
            );
            const published = yield* publication.withLock(
              inputRef,
              Effect.gen(function* () {
                const cached = yield* findImageManifest(inputRef, credentials);
                if (cached) {
                  yield* session.note(`Reusing image ${cached.ref}`);
                  return cached;
                }
                const cacheRef = `${target.name}:buildcache`;
                const tags: [string, ...string[]] = [
                  inputRef,
                  cacheRef,
                  ...(publish.tags ?? []).map((tag) => `${target.name}:${tag}`),
                ];
                yield* docker.image
                  .build(
                    {
                      ...options,
                      tag: [...new Set(tags)] as [string, ...string[]],
                      "cache-from": news.build.cacheFrom ?? [
                        `type=registry,ref=${cacheRef}`,
                      ],
                      "cache-to": news.build.cacheTo ?? ["type=inline"],
                    },
                    undefined,
                    credentials ?? { server },
                  )
                  .pipe(retryImagePublication);
                const manifest = yield* findImageManifest(
                  inputRef,
                  credentials,
                );
                if (!manifest)
                  return yield* Effect.fail(
                    new Error("Published image is missing from the registry"),
                  );
                return manifest;
              }),
            );
            yield* syncImageTags(
              published.ref,
              publish.tags ?? [],
              credentials,
            );
            return {
              ref: published.ref,
              imageRef: news.registry
                ? `${target.name}:${news.tag ?? "latest"}`
                : published.ref,
              repoDigest: published.ref,
              name: target.name,
              tag: news.tag ?? tag,
              hash: build.hash,
            };
          }
          yield* session.note(`Preparing local image ${inputRef}`);
          return yield* ensureLocalImage(
            {
              name: target.name,
              build: news.build,
              dockerContext: target.context,
              tag: news.tag,
            },
            build,
          ).pipe(Effect.provide(Layer.succeed(Docker, docker)));
        }),
        delete: Effect.fn(function* ({ olds, output }) {
          if (!localMode && (olds.publish || (olds.registry && !olds.skipPush)))
            return;
          // Generated repositories belong to one resource instance, including dev reloads.
          const context = dockerContextName(olds.dockerContext ?? olds.context);
          const cachedRefs =
            olds.name === undefined
              ? (yield* docker.run([
                  ...(context ? ["--context", context] : []),
                  "image",
                  "ls",
                  "--filter",
                  `reference=${output.name}:*`,
                  "--format",
                  "{{.Repository}}:{{.Tag}}",
                ])).stdout
                  .split("\n")
                  .filter(
                    (ref) =>
                      ref.startsWith(`${output.name}:`) &&
                      /^[a-f0-9]{64}$/.test(ref.slice(output.name.length + 1)),
                  )
              : [];
          const refs = [
            ...new Set([
              output.imageRef,
              ...(output.hash ? [`${output.name}:${output.hash}`] : []),
              ...cachedRefs,
            ]),
          ];
          for (const ref of refs)
            yield* docker.image
              .remove(
                ref,
                false,
                dockerContextName(olds.dockerContext ?? olds.context),
              )
              .pipe(
                Effect.catchReason(
                  "PlatformError",
                  "NotFound",
                  () => Effect.void,
                ),
              );
        }),
      });
    }),
  ).pipe(Layer.provide(ImagePublicationLive));
