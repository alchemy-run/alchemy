import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { hashDirectory, type MemoOptions } from "../Command/Memo.ts";
import { deepEqual, isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { Docker } from "./Docker.ts";
import {
  type ImageRegistry,
  parseCreatedAt,
  parseRepoDigest,
  repositoryFromImageRef,
  withRegistryHost,
} from "./Registry.ts";

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

export interface ImageProps {
  /** Image tag. @default "latest" */
  tag?: string;
  /** Registry credentials for push. */
  registry?: ImageRegistry;
  /** Skip registry push even when `registry` is set. @default false */
  skipPush?: boolean;
  /** Repository/name for the built image. @default Logical id */
  name?: string;
  /** Docker build configuration. */
  build: DockerBuildOptions;
}

export interface Image extends Resource<
  "Docker.Image",
  ImageProps,
  {
    /** Image repository/name without tag. */
    name: string;
    /** Final image reference. Includes registry host when pushed there. */
    imageRef: string;
    /** Local image id after build/tag. */
    imageId: string;
    /** Registry digest after push when available. */
    repoDigest?: string;
    /** Tag used for the local image. */
    tag: string;
    /** Build timestamp in milliseconds since epoch. */
    builtAt: number;
    /** Hash of the build-context files. */
    contextHash?: string;
  }
> {}

/**
 * Builds, tags, and optionally pushes Docker images through the active Docker
 * context.
 *
 * This resource uses the Docker CLI and whatever daemon or remote context the
 * CLI is configured to target. It is separate from `Cloudflare.Container`;
 * registry image references are the boundary between Docker-managed images and
 * cloud container platforms.
 *
 * `Image` always builds from a Dockerfile. To pull (and optionally re-tag and
 * push) an existing registry image, use `Docker.RemoteImage`.
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
            builtAt: output?.builtAt ?? parseCreatedAt(image.Created),
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

          const paths = yield* resolveBuildPaths(props.build);
          yield* session.note(`Building Docker image: ${ref}`);
          yield* docker.image.build(
            {
              tag: ref,
              context: paths.context,
              file: paths.dockerfile,
              platform: props.build.platform,
              target: props.build.target,
              "build-arg": props.build.args,
              "cache-from": props.build.cacheFrom,
              "cache-to": props.build.cacheTo,
              args: props.build.options,
            },
            session,
          );
          const nextContextHash = yield* contextHash(props);

          // Read the freshly built image's id and creation time straight from
          // Docker rather than synthesizing a wall-clock timestamp.
          const inspected = yield* docker.image.inspect(ref);

          let repoDigest: string | undefined;
          if (props.registry && !props.skipPush) {
            yield* session.note(
              `Pushing image to registry "${props.registry.server}"`,
            );
            repoDigest = yield* docker.image
              .push(ref, props.registry)
              .pipe(
                Effect.map((result) => parseRepoDigest(ref, result.stdout)),
              );
          }

          return {
            name: repositoryFromImageRef(ref),
            imageRef: ref,
            imageId: inspected.Id,
            repoDigest,
            tag,
            builtAt: parseCreatedAt(inspected.Created),
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

export const localImageRef = (id: string, props: ImageProps): string =>
  `${props.name ?? id}:${props.tag ?? "latest"}`;

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
  props.name === undefined
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
