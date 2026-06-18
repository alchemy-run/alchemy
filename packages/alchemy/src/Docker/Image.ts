import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { hashDirectory, type MemoOptions } from "../Build/Memo.ts";
import { deepEqual, isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import {
  buildImage,
  imageId,
  inspectImage,
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

const buildContext = (build: DockerBuildOptions | undefined) =>
  build?.context ?? process.cwd();

const resolveBuildPaths = Effect.fn(function* (build: DockerBuildOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const context = path.resolve(build.context ?? process.cwd());
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

const contextHash = (props: ImageProps) =>
  hasBuild(props)
    ? hashDirectory({ cwd: buildContext(props.build), memo: props.build.memo })
    : Effect.succeed(undefined);

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

export const ImageProvider = () =>
  Provider.succeed(Image, {
    list: () => Effect.succeed([]),
    read: Effect.fnUntraced(function* ({ id, olds, output }) {
      const ref = output?.imageRef ?? localImageRef(id, olds);
      const image = yield* inspectImage(ref);
      if (!image) return undefined;
      return {
        kind: "Image" as const,
        name: output?.name ?? repositoryFromImageRef(ref),
        imageRef: ref,
        imageId: image.Id,
        repoDigest: output?.repoDigest,
        tag: output?.tag ?? olds.tag ?? "latest",
        builtAt: output?.builtAt ?? Date.now(),
        contextHash: output?.contextHash,
      };
    }),
    diff: Effect.fnUntraced(function* ({ id, news, olds, output }) {
      if (!isResolved(news)) return undefined;
      if (!output) return undefined;
      const nextHash = yield* contextHash(news);
      if (
        !deepEqual(comparableProps(olds), comparableProps(news)) ||
        output.imageRef !== desiredImageRef(id, news) ||
        output.contextHash !== nextHash
      ) {
        return { action: "update" as const };
      }
    }),
    reconcile: Effect.fnUntraced(function* ({ id, news, session }) {
      const tag = news.tag ?? "latest";
      const ref = localImageRef(id, news);
      let currentImageId: string | undefined;
      let finalRef = ref;
      let repoDigest: string | undefined;
      let nextContextHash: string | undefined;

      if (hasBuild(news)) {
        const paths = yield* resolveBuildPaths(news.build);
        yield* session.note(`Building Docker image: ${ref}`);
        yield* buildImage({
          tag: ref,
          context: paths.context,
          dockerfile: paths.dockerfile,
          platform: news.build.platform,
          target: news.build.target,
          args: news.build.args,
          cacheFrom: news.build.cacheFrom,
          cacheTo: news.build.cacheTo,
          options: news.build.options,
        });
        nextContextHash = yield* contextHash(news);
        currentImageId = yield* imageId(ref).pipe(
          Effect.catch(() => Effect.succeed(undefined)),
        );
      } else {
        const sourceRef = imageSourceRef(news.image);
        if (!isLocalImageSource(news.image)) {
          const source = yield* inspectImage(sourceRef);
          if (!source) {
            yield* session.note(`Pulling Docker image: ${sourceRef}`);
            yield* pullImage(sourceRef);
          }
        }
        yield* session.note(`Tagging Docker image: ${sourceRef} -> ${ref}`);
        yield* tagImage(sourceRef, ref);
        currentImageId = yield* imageId(ref).pipe(
          Effect.catch(() => Effect.succeed(undefined)),
        );
      }

      if (news.registry && !news.skipPush) {
        const pushed = yield* pushImageToRegistry(
          ref,
          news.registry satisfies RegistryPushCredentials,
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
        builtAt: Date.now(),
        contextHash: nextContextHash,
      };
    }),
    delete: Effect.fnUntraced(function* () {
      // Docker images are intentionally left in place. Tags and image ids are
      // commonly shared by developer workflows outside Alchemy.
    }),
  });
