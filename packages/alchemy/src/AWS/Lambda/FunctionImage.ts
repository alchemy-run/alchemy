import * as ecr from "@distilled.cloud/aws/ecr";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { Docker } from "../../Docker/Docker.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  createInternalTags,
  createTagsList,
  hasAlchemyTags,
} from "../../Tags.ts";
import { sha256Object } from "../../Util/sha256.ts";
import {
  hashDockerBuildInputs,
  resolveDockerBuildPaths,
} from "../ECR/DockerBuild.ts";
import { buildAndPushEcrImage } from "../ECR/Image.ts";
import { AWSEnvironment } from "../Environment.ts";
import { normalizePolicyDocument } from "../IAM/Policy.ts";

/**
 * Docker build input for an image-packaged Lambda function.
 *
 * These values must be literal because Lambda's circular-dependency
 * pre-create phase builds the image before normal Output resolution.
 */
export interface FunctionImageSource {
  /** Docker build context directory. */
  context: string;
  /** Dockerfile path, relative to {@link context} unless absolute. */
  dockerfile: string;
  /**
   * Docker build arguments (`--build-arg`).
   *
   * Build arguments are stored in deployment state and may be retained in
   * image layers. Do not use them for secrets.
   */
  buildArgs?: Record<string, string>;
}

const FunctionImageSourceSchema = Schema.Struct({
  context: Schema.String,
  dockerfile: Schema.String,
  buildArgs: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
}) satisfies Schema.Schema<FunctionImageSource>;

export interface FunctionImageAttributes {
  /** Content hash used as the ECR image tag. */
  hash: string;
  /** Tag-based URI passed to Lambda. */
  imageUri: string;
  /** Digest-pinned URI resolved from ECR. */
  resolvedImageUri: string;
  /** Registry manifest digest. */
  digest: string;
  /** Managed ECR repository name. */
  repositoryName: string;
  /** Managed ECR repository URI. */
  repositoryUri: string;
}

export interface ResolveFunctionImageOptions {
  id: string;
  source: FunctionImageSource;
  architecture: "x86_64" | "arm64";
  repositoryName?: string;
  session: { note: (message: string) => Effect.Effect<void> };
}

/**
 * Increment when the Lambda image build behavior changes in a way that must
 * invalidate already-pushed content-addressed images.
 */
const functionImageBuilderVersion = 1;

export const functionImagePlatform = (architecture: "x86_64" | "arm64") => {
  if (architecture === "x86_64") {
    return "linux/amd64";
  }
  if (architecture === "arm64") {
    return "linux/arm64";
  }
  throw new Error(`Unsupported Lambda image architecture: ${architecture}`);
};

const hashDecodedFunctionImageBuild = Effect.fn(function* (
  source: FunctionImageSource,
  architecture: "x86_64" | "arm64",
) {
  const buildHash = yield* hashDockerBuildInputs(
    {
      ...source,
      platform: functionImagePlatform(architecture),
    },
    "effective",
  );
  return (yield* sha256Object({
    builderVersion: functionImageBuilderVersion,
    buildHash,
  })).slice(0, 32);
});

/**
 * Hash the Docker build context, Dockerfile, build args, target platform, and
 * Lambda image-builder version without including absolute paths.
 */
export const hashFunctionImageBuild = Effect.fn(function* (
  source: FunctionImageSource,
  architecture: "x86_64" | "arm64",
) {
  const decoded = yield* Schema.decodeUnknownEffect(FunctionImageSourceSchema)(
    source,
  );
  return yield* hashDecodedFunctionImageBuild(decoded, architecture);
});

const decodeFunctionImageSource = (id: string, source: unknown) =>
  Schema.decodeUnknownEffect(FunctionImageSourceSchema)(source).pipe(
    Effect.mapError(
      (error) =>
        new Error(
          `Function(${id}): image.context, image.dockerfile, and image.buildArgs must be literal values because the image is built during pre-create`,
          { cause: error },
        ),
    ),
  );

/**
 * Lambda-specific managed image builder. It deliberately stays separate from
 * the ECS/EKS image-source abstraction: Lambda owns a repository policy and
 * accepts only a user-authored Dockerfile/context in this first slice.
 */
export const makeFunctionImage = Effect.gen(function* () {
  const docker = yield* Docker;

  const createRepositoryName = (id: string) =>
    createPhysicalName({
      id: `${id}-image`,
      maxLength: 256,
      lowercase: true,
    });

  const ensureRepository = Effect.fn(function* (
    id: string,
    repositoryName: string,
  ) {
    let repository = yield* ecr
      .describeRepositories({ repositoryNames: [repositoryName] })
      .pipe(
        Effect.map((response) => response.repositories?.[0]),
        Effect.catchTag("RepositoryNotFoundException", () =>
          Effect.succeed(undefined),
        ),
      );

    if (!repository?.repositoryArn || !repository.repositoryUri) {
      const tags = yield* createInternalTags(id);
      repository = yield* ecr
        .createRepository({
          repositoryName,
          imageTagMutability: "MUTABLE",
          imageScanningConfiguration: { scanOnPush: true },
          tags: createTagsList(tags),
        })
        .pipe(
          Effect.map((response) => response.repository),
          Effect.catchTag("RepositoryAlreadyExistsException", () =>
            ecr
              .describeRepositories({ repositoryNames: [repositoryName] })
              .pipe(Effect.map((response) => response.repositories?.[0])),
          ),
        );
    }

    if (!repository?.repositoryArn || !repository.repositoryUri) {
      return yield* Effect.die(
        new Error(
          `Failed to create or read Lambda image repository '${repositoryName}'`,
        ),
      );
    }

    const tags = yield* ecr.listTagsForResource({
      resourceArn: repository.repositoryArn,
    });
    if (!(yield* hasAlchemyTags(id, tags.tags))) {
      return yield* Effect.die(
        new Error(
          `Lambda image repository '${repositoryName}' exists but is not owned by Function(${id})`,
        ),
      );
    }

    const { accountId, region } = yield* AWSEnvironment.current;
    const desiredPolicy = JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "LambdaECRImageRetrievalPolicy",
          Effect: "Allow",
          Principal: { Service: "lambda.amazonaws.com" },
          Action: ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"],
          Condition: {
            StringLike: {
              "aws:sourceArn": `arn:aws:lambda:${region}:${accountId}:function:*`,
            },
          },
        },
      ],
    });
    const observedPolicy = yield* ecr
      .getRepositoryPolicy({ repositoryName })
      .pipe(
        Effect.map((response) => response.policyText),
        Effect.catchTag("RepositoryPolicyNotFoundException", () =>
          Effect.succeed(undefined),
        ),
      );
    if (
      observedPolicy === undefined ||
      normalizePolicyDocument(observedPolicy) !==
        normalizePolicyDocument(desiredPolicy)
    ) {
      yield* ecr.setRepositoryPolicy({
        repositoryName,
        policyText: desiredPolicy,
      });
    }

    return {
      repositoryName,
      repositoryUri: repository.repositoryUri,
    };
  });

  const describeImage = Effect.fn(function* (
    repositoryName: string,
    imageTag: string,
  ) {
    const response = yield* ecr
      .describeImages({
        repositoryName,
        imageIds: [{ imageTag }],
      })
      .pipe(
        Effect.catchTag(
          ["ImageNotFoundException", "RepositoryNotFoundException"],
          () => Effect.succeed(undefined),
        ),
      );
    return response?.imageDetails?.[0];
  });

  const hash = Effect.fn(function* (
    id: string,
    source: FunctionImageSource,
    architecture: "x86_64" | "arm64",
  ) {
    const decoded = yield* decodeFunctionImageSource(id, source);
    return yield* hashDecodedFunctionImageBuild(decoded, architecture);
  });

  const resolve = Effect.fn(function* (options: ResolveFunctionImageOptions) {
    const source = yield* decodeFunctionImageSource(options.id, options.source);
    const imageTag = yield* hashDecodedFunctionImageBuild(
      source,
      options.architecture,
    );
    const repositoryName =
      options.repositoryName ?? (yield* createRepositoryName(options.id));
    // Re-ensure even with persisted metadata: the repository or its Lambda
    // pull policy may have drifted out-of-band.
    const ensured = yield* ensureRepository(options.id, repositoryName);
    const imageUri = `${ensured.repositoryUri}:${imageTag}`;

    let detail = yield* describeImage(repositoryName, imageTag);
    if (!detail?.imageDigest) {
      const build = yield* resolveDockerBuildPaths(source);
      yield* options.session.note(`Building Lambda image ${imageUri}...`);
      yield* buildAndPushEcrImage(docker, {
        imageUri,
        context: build.context,
        dockerfile: build.dockerfile,
        platform: functionImagePlatform(options.architecture),
        buildArgs: source.buildArgs,
        args: ["--provenance=false"],
      });
      detail = yield* describeImage(repositoryName, imageTag).pipe(
        Effect.filterOrFail(
          (image) => image?.imageDigest !== undefined,
          () => new Error(`Image ${imageUri} not found in ECR after push`),
        ),
        Effect.retry({
          schedule: Schedule.spaced("1 second"),
          times: 8,
        }),
      );
      yield* options.session.note(`Pushed ${imageUri}`);
    }

    const digest = detail?.imageDigest;
    if (digest === undefined) {
      return yield* Effect.fail(
        new Error(`Image ${imageUri} has no registry digest after push`),
      );
    }
    return {
      hash: imageTag,
      imageUri,
      resolvedImageUri: `${ensured.repositoryUri}@${digest}`,
      digest,
      repositoryName,
      repositoryUri: ensured.repositoryUri,
    } satisfies FunctionImageAttributes;
  });

  const deleteRepository = (repositoryName: string) =>
    ecr
      .deleteRepository({ repositoryName, force: true })
      .pipe(Effect.catchTag("RepositoryNotFoundException", () => Effect.void));

  const exists = Effect.fn(function* (
    repositoryName: string,
    imageTag: string,
  ) {
    return (
      (yield* describeImage(repositoryName, imageTag))?.imageDigest !==
      undefined
    );
  });

  return { hash, resolve, exists, deleteRepository };
});

export interface FunctionImage extends Effect.Success<
  typeof makeFunctionImage
> {}
