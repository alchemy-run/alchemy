import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Artifacts from "../Artifacts.ts";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { sha256Object } from "../Util/sha256.ts";
import { hashDockerBuildInputs } from "./BuildHash.ts";
import { Docker, dockerContextName, dockerPhysicalName } from "./Docker.ts";
import type { Providers } from "./Providers.ts";
import {
  type ImageRegistry,
  parseCreatedAt,
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
  /** Target platform. Registry publications default to `"linux/amd64"`. */
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
}

export interface ImageProps {
  /**
   * Repository/name for the built image.
   *
   * @default Generated from stack, stage, logical id, and instance id.
   */
  name?: string;
  /** Image tag. Defaults to a build-input hash for registry images, otherwise "latest". */
  tag?: string;
  /** Registry credentials for push. */
  registry?: ImageRegistry;
  /** Skip registry push even when `registry` is set. @default false */
  skipPush?: boolean;
  /** Docker context name or context resource. */
  context?: Docker.ContextRef;
  /** Docker build configuration. */
  build: DockerBuildOptions;
}

export interface Image extends Resource<
  "Docker.Image",
  ImageProps,
  {
    /** Image repository/name without tag. */
    name: string;
    /** Local tag, or immutable repository@digest for a registry publication. */
    imageRef: string;
    /** Local image id. Absent for registry publications; consume `repoDigest` instead. */
    imageId?: string;
    /** Build-input identity of a registry publication. */
    buildHash?: string;
    /** Registry digest after push when available. */
    repoDigest?: string;
    /** Tag used for the local image. */
    tag: string;
    /** Local build or registry observation timestamp in milliseconds since epoch. */
    builtAt: number;
  },
  never,
  Providers
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
 * With `registry` configured, images are published through Buildx and observed
 * in the registry, without requiring a local image store (Buildx 0.26+). Plans hash the build
 * inputs without building or publishing. Omit `tag` to reuse content-addressed
 * publications across fresh runners. Published images are retained on deletion.
 * Set `build.platform` explicitly when sharing builds across architectures.
 *
 * `Image` always builds from a Dockerfile. To pull (and optionally re-tag and
 * push) an existing registry image, use `Docker.RemoteImage`.
 *
 *
 * ### Building Images
 * **Example:** Build from a Dockerfile
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
 * ### Registry Push
 * **Example:** Push with Redacted credentials
 * ```typescript
 * const image = yield* Docker.Image("app", {
 *   name: "my-app",
 *   build: { context: "./app" },
 *   registry: {
 *     server: "ghcr.io",
 *     username: "octocat",
 *     password: Config.Redacted("GITHUB_TOKEN"),
 *   },
 * });
 * ```
 *
 * ### Docker Context
 * **Example:** Build in a named Docker context
 * ```typescript
 * const image = yield* Docker.Image("app", {
 *   name: "my-app",
 *   context: "remote-build",
 *   build: { context: "./app" },
 * });
 * ```
 *
 * @resource
 * @product Image
 */
export const Image = Resource<Image>("Docker.Image");

export const ImageProvider = () =>
  Provider.effect(
    Image,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const docker = yield* Docker;

      const buildAndInspectImage = Effect.fn(function* (
        id: string,
        props: ImageProps,
        instanceId: string,
      ) {
        const name = yield* dockerPhysicalName(id, props, instanceId);
        const engineContext = dockerContextName(props.context);
        const tag = props.tag ?? "latest";
        const ref = `${name}:${tag}`;

        const paths = yield* resolveBuildPaths(props.build);
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
          engineContext,
        });

        // Read the freshly built image's id and creation time straight from
        // Docker rather than synthesizing a wall-clock timestamp.
        return {
          name,
          tag,
          image: yield* docker.image.inspect(ref, engineContext),
          ref,
        };
      }, Artifacts.cached("build"));

      const resolveBuildPaths = Effect.fn(function* (build: DockerBuildOptions) {
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

      const publication = Effect.fn(function* (
        id: string,
        props: ImageProps & { registry: ImageRegistry },
        instanceId: string,
      ) {
        const name = yield* dockerPhysicalName(id, props, instanceId);
        const paths = yield* resolveBuildPaths(props.build);
        const contextHash = yield* hashDockerBuildInputs(
          {
            ...paths,
            platform: props.build.platform ?? "linux/amd64",
            buildArgs: props.build.args,
          },
          "effective",
        );
        const buildHash = yield* sha256Object({
          contextHash,
          target: props.build.target,
          options: props.build.options,
        });
        const tag = props.tag ?? buildHash;
        const ref = withRegistryHost(`${name}:${tag}`, props.registry);
        return { name, tag, ref, paths, buildHash };
      });
      const published = (props: ImageProps): props is ImageProps & { registry: ImageRegistry } =>
        props.registry !== undefined && !props.skipPush;

      return Image.Provider.of({
        list: () => Effect.succeed([]),
        read: Effect.fn(function* ({ id, instanceId, olds, output }) {
          if (published(olds)) {
            const desired = output ?? (yield* publication(id, olds, instanceId));
            const ref = withRegistryHost(`${desired.name}:${desired.tag}`, olds.registry);
            const digest = yield* docker.image.registryDigest(ref, olds.registry);
            if (!digest) return undefined;
            const repoDigest = `${repositoryFromImageRef(ref)}@${digest}`;
            return {
              name: desired.name,
              tag: desired.tag,
              imageRef: repoDigest,
              repoDigest,
              buildHash: output?.repoDigest === repoDigest ? output.buildHash : undefined,
              builtAt: output?.builtAt ?? (yield* Clock.currentTimeMillis),
            };
          }
          const context = dockerContextName(olds.context);
          const ref =
            output?.imageRef ??
            (yield* dockerPhysicalName(id, olds, instanceId).pipe(
              Effect.map((name) => `${name}:${olds.tag ?? "latest"}`),
            ));
          const image = yield* docker.image
            .inspect(ref, context)
            .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined));
          if (!image) return undefined;
          return {
            name: output?.name ?? repositoryFromImageRef(ref),
            imageRef: ref,
            imageId: image.Id,
            repoDigest: output?.repoDigest,
            tag: output?.tag ?? olds.tag ?? "latest",
            builtAt: output?.builtAt ?? parseCreatedAt(image.Created),
          };
        }),
        diff: Effect.fn(function* ({ id, instanceId, news, output, olds }) {
          if (!isResolved(news) || !output) return undefined;
          if (published(news)) {
            const desired = yield* publication(id, news, instanceId);
            if (
              output.buildHash !== desired.buildHash ||
              withRegistryHost(`${output.name}:${output.tag}`, news.registry) !== desired.ref ||
              !published(olds)
            ) {
              return { action: "update" };
            }
            const digest = yield* docker.image.registryDigest(desired.ref, news.registry);
            if (
              !digest ||
              output.repoDigest !== `${repositoryFromImageRef(desired.ref)}@${digest}`
            ) {
              return { action: "update" };
            }
            return;
          }
          if (
            published(olds) ||
            dockerContextName(olds.context) !== dockerContextName(news.context)
          ) {
            return { action: "update" };
          }
          const { image } = yield* buildAndInspectImage(id, news, instanceId);
          if (output?.imageId !== image.Id) {
            return { action: "update" };
          }
        }),
        reconcile: Effect.fn(function* ({ id, instanceId, news, session, output }) {
          if (published(news)) {
            const { name, tag, ref, paths, buildHash } = yield* publication(id, news, instanceId);
            // Only content-addressed tags can be reused without trusting prior state.
            let digest =
              news.tag === undefined
                ? yield* docker.image.registryDigest(ref, news.registry)
                : undefined;
            if (
              digest &&
              output &&
              withRegistryHost(`${output.name}:${output.tag}`, news.registry) === ref &&
              output.repoDigest !== `${repositoryFromImageRef(ref)}@${digest}`
            ) {
              digest = undefined;
            }
            if (!digest) {
              yield* session.note(`Publishing image ${ref}`);
              yield* docker.image.build(
                {
                  tag: ref,
                  context: paths.context,
                  file: paths.dockerfile,
                  platform: news.build.platform ?? "linux/amd64",
                  target: news.build.target,
                  "build-arg": news.build.args,
                  "cache-from": news.build.cacheFrom,
                  "cache-to": news.build.cacheTo,
                  args: news.build.options,
                  engineContext: dockerContextName(news.context),
                },
                undefined,
                news.registry,
              );
              digest = yield* docker.image.registryDigest(ref, news.registry);
            }
            if (!digest)
              return yield* Effect.fail(
                new Error(`Published image is missing from the registry: ${ref}`),
              );
            return {
              name,
              tag,
              imageRef: `${repositoryFromImageRef(ref)}@${digest}`,
              repoDigest: `${repositoryFromImageRef(ref)}@${digest}`,
              buildHash,
              builtAt: yield* Clock.currentTimeMillis,
            };
          }
          const { name, tag, image, ref } = yield* buildAndInspectImage(id, news, instanceId);

          return {
            name,
            imageRef: ref,
            imageId: image.Id,
            tag,
            builtAt: parseCreatedAt(image.Created),
          };
        }),
        delete: Effect.fn(({ olds, output }) =>
          published(olds)
            ? Effect.void
            : docker.image
                .remove(output.imageRef, undefined, dockerContextName(olds.context))
                .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.void)),
        ),
      });
    }),
  );
