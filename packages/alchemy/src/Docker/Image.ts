import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { hashDirectory, type MemoOptions } from "../Command/Memo.ts";
import { deepEqual, isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { Docker } from "./Docker.ts";

export interface DockerBuildOptions {
  /**
   * Build context directory.
   *
   * @default Current working directory.
   */
  context?: string;
  /**
   * Dockerfile path, relative to the context unless absolute.
   *
   * @default "Dockerfile"
   */
  dockerfile?: string;
  /** Target platform, e.g. `"linux/amd64"`. */
  platform?: string;
  /** Docker build arguments. */
  args?: Record<string, string>;
  /** Multi-stage build target. */
  target?: string;
  /** Cache sources passed as `--cache-from`. */
  cacheFrom?: string[];
  /** Cache destinations passed as `--cache-to`. */
  cacheTo?: string[];
  /** Additional Docker build options. */
  options?: string[];
  /** Files included in the build-context hash used for rebuild decisions. */
  memo?: MemoOptions;
}

export interface ImageRegistry {
  /** Registry host, e.g. `ghcr.io`. */
  server: string;
  /** Registry username. */
  username: string;
  /** Registry password. Use `Redacted.make(...)` or `Config.redacted(...)`. */
  password: Redacted.Redacted<string>;
}

export type ImageSource =
  | string
  | { imageRef: string; name?: string; kind?: "Image" | "RemoteImage" };

export type ImageProps = {
  /** Image tag. @default "latest" */
  tag?: string;
  /** Registry credentials for push. */
  registry?: ImageRegistry;
  /** Skip registry push even when `registry` is set. @default false */
  skipPush?: boolean;
} & (
  | {
      /** Existing image reference or another Docker image resource. */
      image: ImageSource;
      build?: never;
      name?: never;
    }
  | {
      /** Repository/name for the built image. @default Logical id */
      name?: string;
      /** Docker build configuration. */
      build: DockerBuildOptions;
      image?: never;
    }
);

export interface Image extends Resource<
  "Docker.Image",
  ImageProps,
  {
    /** Image repository/name without tag. */
    name: string;
    /** Final image reference. Includes registry host when pushed there. */
    imageRef: string;
    /** Local image id after build/tag when available. */
    imageId?: string;
    /** Registry digest after push when available. */
    repoDigest?: string;
    /** Tag used for the local image. */
    tag: string;
    /** Build timestamp in milliseconds since epoch. */
    builtAt: number;
    /** Hash of build-context files when `build` is used. */
    contextHash?: string;
  }
> {}

/**
 * Builds, pulls, tags, and optionally pushes Docker images through the active
 * Docker context.
 *
 * This resource uses the Docker CLI and whatever daemon or remote context the
 * CLI is configured to target. It is separate from `Cloudflare.Container`;
 * registry image references are the boundary between Docker-managed images and
 * cloud container platforms.
 *
 * @resource
 *
 * @section Building Images
 * @example Build from a Dockerfile
 * ```typescript
 * const image = yield* Docker.Image("app", {
 *   name: "my-app",
 *   tag: "latest",
 *   build: {
 *     context: "./app",
 *     dockerfile: "Dockerfile",
 *     args: { NODE_ENV: "production" },
 *   },
 * });
 * ```
 *
 * @section Tagging Remote Images
 * @example Pull and tag an image reference
 * ```typescript
 * const image = yield* Docker.Image("nginx", {
 *   image: "nginx:alpine",
 *   tag: "app-base",
 * });
 * ```
 *
 * @section Registry Push
 * @example Push with Redacted credentials
 * ```typescript
 * const image = yield* Docker.Image("app", {
 *   name: "my-app",
 *   build: { context: "./app" },
 *   registry: {
 *     server: "ghcr.io",
 *     username: "octocat",
 *     password: Config.redacted("GITHUB_TOKEN"),
 *   },
 * });
 * ```
 */
export const Image = Resource<Image>("Docker.Image");

export const ImageProvider = () =>
  Provider.effect(
    Image,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const docker = yield* Docker;
      const context = yield* Effect.context<
        FileSystem.FileSystem | Path.Path
      >();

      const contextHash = Effect.fn(function* (props: ImageProps) {
        if (!hasBuild(props)) return undefined;
        const cwd = yield* Effect.sync(() => process.cwd());
        return yield* hashDirectory({
          cwd: props.build.context ?? cwd,
          memo: props.build.memo,
        });
      }, Effect.provide(context));

      const resolveBuildPaths = Effect.fn(function* (
        build: DockerBuildOptions,
      ) {
        const cwd = yield* Effect.sync(() => process.cwd());
        const context = path.resolve(build.context ?? cwd);
        const dockerfile = build.dockerfile
          ? path.isAbsolute(build.dockerfile)
            ? build.dockerfile
            : path.resolve(context, build.dockerfile)
          : path.resolve(context, "Dockerfile");
        if (!(yield* fs.exists(context))) {
          return yield* Effect.die(
            `Docker build context does not exist: ${context}`,
          );
        }
        if (!(yield* fs.exists(dockerfile))) {
          return yield* Effect.die(`Dockerfile does not exist: ${dockerfile}`);
        }
        return { context, dockerfile };
      });

      return Image.Provider.of({
        list: () => Effect.succeed([]),
        read: Effect.fn(function* ({ id, instanceId, olds, output }) {
          const props = yield* withResolvedName(id, olds, instanceId);
          const ref = output?.imageRef ?? localImageRef(id, props);
          const image = yield* docker.image
            .inspect(ref)
            .pipe(
              Effect.catchReason(
                "PlatformError",
                "NotFound",
                () => Effect.undefined,
              ),
            );
          if (!image) return undefined;
          return {
            name: output?.name ?? repositoryFromImageRef(ref),
            imageRef: ref,
            imageId: image.Id,
            repoDigest: output?.repoDigest,
            tag: output?.tag ?? olds.tag ?? "latest",
            builtAt: output?.builtAt ?? Date.parse(image.Created ?? ""),
            contextHash: output?.contextHash,
          };
        }),
        diff: Effect.fn(function* ({ id, instanceId, news, olds, output }) {
          if (!isResolved(news)) return undefined;
          if (!output) return undefined;
          const props = yield* withResolvedName(id, news, instanceId);
          const nextHash = yield* contextHash(news);
          if (
            !deepEqual(comparableProps(olds), comparableProps(news)) ||
            output.imageRef !== desiredImageRef(id, props) ||
            output.contextHash !== nextHash
          ) {
            return { action: "update" as const };
          }
        }),
        reconcile: Effect.fn(function* ({ id, instanceId, news, session }) {
          const props = yield* withResolvedName(id, news, instanceId);
          const tag = props.tag ?? "latest";
          const ref = localImageRef(id, props);
          let finalRef = ref;
          let repoDigest: string | undefined;
          let nextContextHash: string | undefined;

          if (hasBuild(props)) {
            const paths = yield* resolveBuildPaths(props.build);
            yield* session.note(`Building Docker image: ${ref}`);
            yield* docker.image.build({
              tag: ref,
              context: paths.context,
              file: paths.dockerfile,
              platform: props.build.platform,
              target: props.build.target,
              "build-arg": props.build.args,
              "cache-from": props.build.cacheFrom,
              "cache-to": props.build.cacheTo,
              args: props.build.options,
            });
            nextContextHash = yield* contextHash(props);
          } else {
            const sourceRef = imageSourceRef(props.image);
            if (!isLocalImageSource(props.image)) {
              const source = yield* docker.image
                .inspect(sourceRef)
                .pipe(
                  Effect.catchReason(
                    "PlatformError",
                    "NotFound",
                    () => Effect.undefined,
                  ),
                );
              if (!source) {
                yield* session.note(`Pulling Docker image: ${sourceRef}`);
                yield* docker.image.pull(sourceRef);
              }
            }
            yield* session.note(`Tagging Docker image: ${sourceRef} -> ${ref}`);
            yield* docker.image.tag(sourceRef, ref);
          }

          // Read the freshly built/tagged image's id and creation time straight
          // from Docker rather than synthesizing a wall-clock timestamp.
          const inspected = yield* docker.image.inspect(ref);
          const currentImageId = inspected?.Id;
          const builtAt = Date.parse(inspected?.Created ?? "");

          if (props.registry && !props.skipPush) {
            repoDigest = yield* docker.image
              .push(ref, props.registry)
              .pipe(
                Effect.map((result) => parseRepoDigest(ref, result.stdout)),
              );
          }

          return {
            name: repositoryFromImageRef(finalRef),
            imageRef: finalRef,
            imageId: currentImageId,
            repoDigest,
            tag,
            builtAt,
            contextHash: nextContextHash,
          };
        }),
        delete: Effect.fn(({ output }) =>
          docker.image
            .remove(output.imageRef)
            .pipe(
              Effect.catchReason(
                "PlatformError",
                "NotFound",
                () => Effect.void,
              ),
            ),
        ),
      });
    }),
  );

const imageSourceRef = (source: ImageSource): string =>
  typeof source === "string" ? source : source.imageRef;

const imageSourceName = (source: ImageSource): string | undefined =>
  typeof source === "string"
    ? repositoryFromImageRef(source)
    : (source.name ?? repositoryFromImageRef(source.imageRef));

const isLocalImageSource = (source: ImageSource): boolean =>
  typeof source !== "string" && source.kind === "Image";

const hasBuild = (
  props: ImageProps,
): props is Extract<ImageProps, { build: DockerBuildOptions }> =>
  "build" in props && props.build !== undefined;

export const localImageRef = (id: string, props: ImageProps): string => {
  const tag = props.tag ?? "latest";
  const name = hasBuild(props)
    ? (props.name ?? id)
    : (imageSourceName(props.image) ?? id);
  return `${name}:${tag}`;
};

export const desiredImageRef = (id: string, props: ImageProps): string => {
  const ref = localImageRef(id, props);
  return props.registry && !props.skipPush
    ? withRegistryHost(ref, props.registry)
    : ref;
};

/**
 * Resolves the built image's repository name. When a build has no explicit
 * `name`, an engine physical name is generated (stack + stage + logical id +
 * instance id) just like other resources, then carried back on `props.name` so
 * the synchronous ref helpers stay deterministic across reconcile/diff/read.
 */
const withResolvedName = (id: string, props: ImageProps, instanceId: string) =>
  hasBuild(props) && props.name === undefined
    ? createPhysicalName({
        id,
        instanceId,
        maxLength: 128,
        lowercase: true,
      }).pipe(Effect.map((name): ImageProps => ({ ...props, name })))
    : Effect.succeed(props);

const comparableProps = (props: ImageProps | undefined) =>
  props
    ? {
        ...props,
        registry: props.registry
          ? {
              server: props.registry.server,
              username: props.registry.username,
              password: props.registry.password,
            }
          : undefined,
      }
    : undefined;

const parseRepoDigest = (
  imageRef: string,
  output: string,
): string | undefined => {
  const match = /digest:\s+([a-z0-9]+:[a-f0-9]{64})/i.exec(output);
  if (!match) return undefined;
  return `${repositoryFromImageRef(imageRef)}@${match[1]}`;
};

const repositoryFromImageRef = (imageRef: string): string => {
  const withoutDigest = imageRef.includes("@")
    ? imageRef.slice(0, imageRef.indexOf("@"))
    : imageRef;
  const tagSeparator = withoutDigest.lastIndexOf(":");
  const pathSeparator = withoutDigest.lastIndexOf("/");
  return tagSeparator > pathSeparator
    ? withoutDigest.slice(0, tagSeparator)
    : withoutDigest;
};

const withRegistryHost = (
  imageRef: string,
  registry: { server: string },
): string => {
  const registryHost = registry.server.replace(/\/$/, "");
  const firstSegment = imageRef.split("/")[0];
  const hasRegistryPrefix =
    imageRef.includes("/") &&
    (firstSegment.includes(".") ||
      firstSegment.includes(":") ||
      firstSegment === "localhost");
  return hasRegistryPrefix ? imageRef : `${registryHost}/${imageRef}`;
};
