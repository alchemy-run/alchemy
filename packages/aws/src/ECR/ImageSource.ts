import {
  makeContainerImageSource,
  type ImageAgent,
  type ImageRegistryTarget,
  type ImageSourceLike,
} from "@alchemy.run/docker/ImageSource";
import * as ecr from "@distilled.cloud/aws/ecr";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Schema from "effect/Schema";
import { roleHostBundle } from "../AWSBindings.ts";
import { getEcrRegistryCredentials } from "./Image.ts";

/**
 * INTERNAL — the ECR target for the shared container image-source machinery
 * ([Docker/ImageSource.ts](../../Docker/ImageSource.ts)), used by the AWS
 * container platforms (`AWS.ECS.Task`, `AWS.ECS.Service`, `AWS.EKS.*`).
 *
 * NOT exported from the AWS barrel or `ECR/index.ts`. Consumers import the
 * module path directly.
 *
 * Every source lands in an auto-created (caller-named) private ECR
 * repository so the compute platform pulls from a registry that is reliable
 * from private VPCs and IAM-authenticated.
 */

export {
  computeStaticSourceHash,
  IMAGE_AGENT_DIR,
  imageAgentEntryPoint,
  imageSourceKind,
  validateImageSource,
  type BundledImageSource,
  type DockerfileImageSource,
  type ImageAgent,
  type ImageSourceKind,
  type ImageSourceLike,
  type ImageSourceProps,
  type RegistryImageSource,
} from "@alchemy.run/docker/ImageSource";

/** The resolved (built/mirrored + pushed) image. */
export interface ResolvedImage {
  /** Full image reference, `<repositoryUri>:<codeHash>`. */
  imageUri: string;
  /** Name of the ECR repository the image was pushed to. */
  repositoryName: string;
  /** URI of the ECR repository the image was pushed to. */
  repositoryUri: string;
  /**
   * Content hash identifying the image. It is the image's tag, unless an
   * agent was published beside the image: the hash then covers both.
   */
  codeHash: string;
  /** The agent published beside the image, when one was asked for. */
  agent: ResolvedImageAgent | undefined;
}

/**
 * An agent published beside an image, and what the image starts by itself,
 * so a platform that starts the agent first can have it start the image's
 * own process.
 */
export interface ResolvedImageAgent {
  /** The agent's own image, `<repositoryUri>:agent-<hash>`. */
  imageUri: string;
  /** The image's `ENTRYPOINT`. Empty when it has none. */
  entryPoint: string[];
  /** The image's `CMD`. Empty when it has none. */
  command: string[];
}

/** An image's configuration could not be read back from its ECR repository. */
export class ImageConfigUnreadable extends Data.TaggedError("ImageConfigUnreadable")<{
  readonly message: string;
  readonly imageUri: string;
}> {}

/** An image manifest, or the index of the manifests of a multi-platform image. */
const decodeImageManifest = Schema.Struct({
  config: Schema.Struct({ digest: Schema.String }).pipe(Schema.optional),
  manifests: Schema.Array(
    Schema.Struct({
      digest: Schema.String,
      platform: Schema.Struct({
        os: Schema.String.pipe(Schema.optional),
        architecture: Schema.String.pipe(Schema.optional),
      }).pipe(Schema.optional),
    }),
  ).pipe(Schema.optional),
}).pipe(Schema.fromJsonString, (schema) => Schema.decodeEffect(schema));

/** The part of an image's configuration that says what it starts. */
const decodeImageConfig = Schema.Struct({
  config: Schema.Struct({
    Entrypoint: Schema.Array(Schema.String).pipe(Schema.NullOr, Schema.optional),
    Cmd: Schema.Array(Schema.String).pipe(Schema.NullOr, Schema.optional),
  }).pipe(Schema.NullOr, Schema.optional),
}).pipe(Schema.fromJsonString, (schema) => Schema.decodeEffect(schema));

export interface ResolveImageOptions {
  /** Logical resource id — keys the stable build-context directory. */
  id: string;
  /**
   * The props bag carrying the image source fields (`main` / `context` /
   * `image` plus their modifiers).
   */
  source: ImageSourceLike;
  /** Name of the ECR repository to (auto-create and) push into. */
  repositoryName: string;
  /**
   * Known repository URI (from prior Attributes). When provided, repository
   * creation is skipped.
   */
  repositoryUri?: string;
  /** Tags applied to the auto-created repository. */
  tags?: Record<string, string>;
  /**
   * Target image platform.
   * @default "linux/amd64"
   */
  platform?: string;
  /**
   * Port the generated Dockerfile should `ENV PORT=` + `EXPOSE`
   * (`main` source only).
   */
  port?: number;
  /**
   * True when the resource was declared without an inline Effect impl —
   * `main` is then bundled as-is without the virtual-entry bootstrap.
   */
  isExternal?: boolean;
  /**
   * The virtual-entry bootstrap wrapped around `main` for Effect-native
   * programs: receives the resolved entry import path and returns the
   * generated entry module source. Platform-specific (server vs one-shot
   * differ per platform), so the caller supplies it.
   */
  bootstrap: (importPath: string) => string;
  /**
   * Publish a sandbox agent beside an image that has no `main`. The image
   * itself is not changed: the agent is an image of its own in the same
   * repository, for the platform to mount into the image's container.
   */
  agent?: ImageAgent;
  /** Plan-status session used to emit build/push progress notes. */
  session: { note: (message: string) => Effect.Effect<void> };
}

/**
 * The generated entry for `AWS.ECS.Task` / `AWS.ECS.Service` containers: a
 * shim importing only `@alchemy.run/aws/Bootstrap/Ecs` (resolvable from any
 * consumer — `alchemy` is its direct dependency) plus the user's `main`.
 * Everything the runtime needs lives in that real module, so the virtual
 * entry never imports alchemy's own dependencies (`@distilled.cloud/*`,
 * `@effect/platform-bun`), which an isolated install cannot resolve from
 * the consumer's project.
 */
export const makeBunBootstrap =
  (handler: string) =>
  (importPath: string): string =>
    `
import { bootstrap } from "@alchemy.run/aws/Bootstrap/Ecs";
import { ${handler} as entrypoint } from ${JSON.stringify(importPath)};

await bootstrap(entrypoint);
`;

/**
 * An ECR image runs on ECS or EKS, as an IAM role, so a bundled `main` is
 * built with {@link roleHostBundle}.
 */
const onRoleHost = <S extends ImageSourceLike>(source: S): S =>
  source.main === undefined
    ? source
    : { ...source, build: { ...source.build, input: roleHostBundle(source.build?.input ?? {}) } };

/**
 * Init-time constructor for the ECR image-source resolver: the shared
 * container image pipeline pushing into an auto-created ECR repository.
 */
export const makeImageSource = Effect.gen(function* () {
  const images = yield* makeContainerImageSource;

  /**
   * Ensure the target ECR repository exists. Idempotent: tolerates
   * `RepositoryAlreadyExistsException` as a race / re-run and re-describes.
   */
  const ensureRepository = Effect.fn(function* (options: {
    repositoryName: string;
    tags?: Record<string, string>;
  }) {
    const created = yield* ecr
      .createRepository({
        repositoryName: options.repositoryName,
        imageTagMutability: "MUTABLE",
        imageScanningConfiguration: { scanOnPush: true },
        tags: Object.entries(options.tags ?? {}).map(([Key, Value]) => ({ Key, Value })),
      })
      .pipe(
        Effect.catchTag("RepositoryAlreadyExistsException", () =>
          Effect.gen(function* () {
            const existing = yield* ecr.describeRepositories({
              repositoryNames: [options.repositoryName],
            });
            return { repository: existing.repositories?.[0] };
          }),
        ),
      );
    const repository = created.repository;
    if (!repository?.repositoryUri) {
      return yield* Effect.die(
        new Error(`Failed to resolve ECR repository '${options.repositoryName}'`),
      );
    }
    return repository.repositoryUri;
  });

  /** Observe a pushed tag in ECR. Missing repository or tag → false. */
  const hasTag = (repositoryName: string) =>
    Effect.fn(function* (imageTag: string) {
      const described = yield* ecr
        .describeImages({ repositoryName, imageIds: [{ imageTag }] })
        .pipe(
          Effect.catchTag(
            ["ImageNotFoundException", "RepositoryNotFoundException"],
            () => Effect.undefined,
          ),
        );
      return described?.imageDetails?.[0] !== undefined;
    });

  /** Observe the manifest of one image of a repository, by tag or by digest. */
  const readManifest = Effect.fn(function* (options: {
    repositoryName: string;
    imageUri: string;
    imageId: ecr.ImageIdentifier;
  }) {
    const { repositoryName, imageUri } = options;
    const response = yield* ecr.batchGetImage({ repositoryName, imageIds: [options.imageId] });
    const text = response.images?.[0]?.imageManifest;
    if (text === undefined) {
      return yield* new ImageConfigUnreadable({
        imageUri,
        message: `ECR returned no manifest for ${imageUri}: ${
          response.failures?.[0]?.failureReason ?? "the image is missing"
        }`,
      });
    }
    return yield* decodeImageManifest(text).pipe(
      Effect.mapError(
        (cause) =>
          new ImageConfigUnreadable({
            imageUri,
            message: `The manifest of ${imageUri} is not one this deploy can read: ${cause.message}`,
          }),
      ),
    );
  });

  /**
   * Observe the digest of an image's configuration. A multi-platform tag
   * holds an index, which is followed to the manifest of `platform`.
   */
  const readConfigDigest = Effect.fn(function* (options: {
    repositoryName: string;
    imageUri: string;
    imageTag: string;
    platform: string;
  }) {
    const { repositoryName, imageUri, platform } = options;
    const tagged = yield* readManifest({
      repositoryName,
      imageUri,
      imageId: { imageTag: options.imageTag },
    });
    if (tagged.config !== undefined) return tagged.config.digest;
    const [os, architecture] = platform.split("/");
    const entry = tagged.manifests?.find(
      (candidate) =>
        candidate.platform?.os === os && candidate.platform?.architecture === architecture,
    );
    if (entry === undefined) {
      return yield* new ImageConfigUnreadable({
        imageUri,
        message: `${imageUri} has no image for ${platform}`,
      });
    }
    const manifest = yield* readManifest({
      repositoryName,
      imageUri,
      imageId: { imageDigest: entry.digest },
    });
    if (manifest.config === undefined) {
      return yield* new ImageConfigUnreadable({
        imageUri,
        message: `The ${platform} manifest of ${imageUri} names no configuration`,
      });
    }
    return manifest.config.digest;
  });

  /**
   * Observe what an image starts by itself: its `ENTRYPOINT` and `CMD`, read
   * from the image's configuration in ECR. Reading it back from the registry
   * covers every source alike (a mirrored image, a build, a tag pushed by an
   * earlier deploy) and needs no Docker.
   */
  const readImageProcess = Effect.fn(function* (options: {
    repositoryName: string;
    imageUri: string;
    imageTag: string;
    platform: string;
  }) {
    const { repositoryName, imageUri } = options;
    const layerDigest = yield* readConfigDigest(options);
    const { downloadUrl } = yield* ecr.getDownloadUrlForLayer({ repositoryName, layerDigest });
    if (downloadUrl === undefined) {
      return yield* new ImageConfigUnreadable({
        imageUri,
        message: `ECR returned no download URL for the configuration of ${imageUri}`,
      });
    }
    // The URL is the one ECR hands back for the blob: it is fetched as it
    // is, with no credentials. It is signed, so it stays out of the error.
    const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
    const text = yield* client.get(downloadUrl).pipe(
      Effect.flatMap((response) => response.text),
      Effect.mapError(
        (cause) =>
          new ImageConfigUnreadable({
            imageUri,
            message: `The configuration of ${imageUri} could not be downloaded from ECR (${cause._tag})`,
          }),
      ),
    );
    const { config } = yield* decodeImageConfig(text).pipe(
      Effect.mapError(
        (cause) =>
          new ImageConfigUnreadable({
            imageUri,
            message: `The configuration of ${imageUri} is not one this deploy can read: ${cause.message}`,
          }),
      ),
    );
    return {
      entryPoint: [...(config?.Entrypoint ?? [])],
      command: [...(config?.Cmd ?? [])],
    };
  }, Effect.provide(FetchHttpClient.layer));

  /**
   * Resolve the image for a props bag: ensure the repository, compute the
   * content-addressed tag, then build/mirror + push only when that exact
   * tag is not already in ECR (crash-safe convergence).
   */
  const resolve = Effect.fn(function* (options: ResolveImageOptions) {
    const target = {
      repositoryUri:
        options.repositoryUri !== undefined
          ? Effect.succeed(options.repositoryUri)
          : ensureRepository({ repositoryName: options.repositoryName, tags: options.tags }),
      hasTag: hasTag(options.repositoryName),
      credentials: getEcrRegistryCredentials,
    } satisfies ImageRegistryTarget<any>;
    const resolved = yield* images.resolve(
      { ...options, source: onRoleHost(options.source) },
      target,
    );
    return {
      imageUri: resolved.imageUri,
      repositoryName: options.repositoryName,
      repositoryUri: resolved.repositoryUri,
      codeHash: resolved.codeHash,
      agent:
        resolved.agent === undefined
          ? undefined
          : {
              imageUri: resolved.agent.imageUri,
              ...(yield* readImageProcess({
                repositoryName: options.repositoryName,
                imageUri: resolved.imageUri,
                imageTag: resolved.imageUri.slice(resolved.repositoryUri.length + 1),
                platform: options.platform ?? "linux/amd64",
              })),
            },
    } satisfies ResolvedImage;
  });

  const hash = (options: Parameters<typeof images.hash>[0]) =>
    images.hash({ ...options, source: onRoleHost(options.source) });
  const watchMain = (options: Parameters<typeof images.watchMain>[0]) =>
    images.watchMain({ ...options, source: onRoleHost(options.source) });

  return { resolve, hash, watchMain };
});

/** The resolver service returned by {@link makeImageSource}. */
export interface ImageSource extends Effect.Success<typeof makeImageSource> {}
