import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { hashDirectory, type MemoOptions } from "../Command/Memo.ts";
import { deepEqual, isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import {
  buildImage,
  imageCreatedAt,
  inspectImageInfo,
  pullImage,
  pushImageToRegistry,
  repositoryFromImageRef,
  tagImage,
  withRegistryHost,
  type RegistryPushCredentials,
} from "./DockerApi.ts";

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
    kind: "Image";
    /** Image repository/name without tag. */
    name: string;
    /** Final image reference. Includes registry host when pushed there. */
    imageRef: string;
    /** Local image id after build/tag when available. */
    imageId?: string;
    /** Registry repository digest after push when available. */
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
  Provider.succeed(Image, {
    list: () => Effect.succeed([]),
    read: Effect.fn(function* ({ id, instanceId, olds, output }) {
      const props = yield* withResolvedName(id, olds, instanceId);
      const ref = output?.imageRef ?? localImageRef(id, props);
      const image = yield* inspectImageInfo(ref);
      if (!image) return undefined;
      return {
        kind: "Image" as const,
        name: output?.name ?? repositoryFromImageRef(ref),
        imageRef: ref,
        imageId: image.Id,
        repoDigest: output?.repoDigest,
        tag: output?.tag ?? olds.tag ?? "latest",
        builtAt: output?.builtAt ?? imageCreatedAt(image),
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
        yield* buildImage({
          tag: ref,
          context: paths.context,
          dockerfile: paths.dockerfile,
          platform: props.build.platform,
          target: props.build.target,
          args: props.build.args,
          cacheFrom: props.build.cacheFrom,
          cacheTo: props.build.cacheTo,
          options: props.build.options,
        });
        nextContextHash = yield* contextHash(props);
      } else {
        const sourceRef = imageSourceRef(props.image);
        if (!isLocalImageSource(props.image)) {
          const source = yield* inspectImageInfo(sourceRef);
          if (!source) {
            yield* session.note(`Pulling Docker image: ${sourceRef}`);
            yield* pullImage(sourceRef);
          }
        }
        yield* session.note(`Tagging Docker image: ${sourceRef} -> ${ref}`);
        yield* tagImage(sourceRef, ref);
      }

      // Read the freshly built/tagged image's id and creation time straight
      // from Docker rather than synthesizing a wall-clock timestamp.
      const inspected = yield* inspectImageInfo(ref);
      const currentImageId = inspected?.Id;
      const builtAt = imageCreatedAt(inspected);

      if (props.registry && !props.skipPush) {
        const pushed = yield* pushImageToRegistry(
          ref,
          props.registry satisfies RegistryPushCredentials,
        );
        finalRef = pushed.imageRef;
        repoDigest = pushed.repoDigest;
      }

      return {
        kind: "Image" as const,
        name: repositoryFromImageRef(finalRef),
        imageRef: finalRef,
        imageId: currentImageId,
        repoDigest,
        tag,
        builtAt,
        contextHash: nextContextHash,
      };
    }),
    delete: Effect.fn(function* () {
      // Docker images are intentionally left in place. Tags and image ids are
      // commonly shared by developer workflows outside Alchemy.
    }),
  });

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
const withResolvedName = (
  id: string,
  props: ImageProps,
  instanceId: string,
): Effect.Effect<ImageProps, never, any> =>
  hasBuild(props) && props.name === undefined
    ? createPhysicalName({
        id,
        instanceId,
        maxLength: 128,
        lowercase: true,
      }).pipe(Effect.map((name): ImageProps => ({ ...props, name })))
    : Effect.succeed(props);

const resolveBuildPaths = Effect.fn(function* (build: DockerBuildOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* Effect.sync(() => process.cwd());
  const context = path.resolve(build.context ?? cwd);
  const dockerfile = build.dockerfile
    ? path.isAbsolute(build.dockerfile)
      ? build.dockerfile
      : path.resolve(context, build.dockerfile)
    : path.resolve(context, "Dockerfile");
  if (!(yield* fs.exists(context))) {
    return yield* Effect.die(`Docker build context does not exist: ${context}`);
  }
  if (!(yield* fs.exists(dockerfile))) {
    return yield* Effect.die(`Dockerfile does not exist: ${dockerfile}`);
  }
  return { context, dockerfile };
});

const contextHash = Effect.fn(function* (props: ImageProps) {
  if (!hasBuild(props)) return undefined;
  const cwd = yield* Effect.sync(() => process.cwd());
  return yield* hashDirectory({
    cwd: props.build.context ?? cwd,
    memo: props.build.memo,
  });
});

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
