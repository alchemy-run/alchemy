import * as ecr from "@distilled.cloud/aws/ecr";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as crypto from "node:crypto";
import { Docker } from "../../Docker/Docker.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  createInternalTags,
  createTagsList,
  hasAlchemyTags,
} from "../../Tags.ts";
import { buildAndPushEcrImage } from "../ECR/Image.ts";
import { AWSEnvironment } from "../Environment.ts";

/**
 * Docker build input for an image-packaged Lambda function.
 *
 * These values must be literal because Lambda's circular-dependency
 * pre-create phase builds the image before normal Output resolution.
 */
export interface FunctionImageSource {
  /** Docker build context directory. */
  context: string;
  /**
   * Dockerfile path, relative to {@link context} unless absolute.
   * @default "Dockerfile"
   */
  dockerfile?: string;
  /**
   * Docker build arguments (`--build-arg`).
   *
   * Build arguments are stored in deployment state and may be retained in
   * image layers. Do not use them for secrets.
   */
  buildArgs?: Record<string, string>;
}

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

interface DockerIgnoreRule {
  ignored: boolean;
  expression: RegExp;
}

/**
 * Increment when the Lambda image build behavior changes in a way that must
 * invalidate already-pushed content-addressed images.
 */
const functionImageBuilderVersion = 1;

export const functionImagePlatform = (
  architecture: "x86_64" | "arm64" = "x86_64",
) => (architecture === "arm64" ? "linux/arm64" : "linux/amd64");

const normalizeRelativePath = (value: string) =>
  value.replaceAll("\\", "/").replace(/^\.\/+/, "");

const escapeRegExp = (value: string) =>
  value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");

/**
 * Compile Docker's ordered `.dockerignore` pattern form into a path matcher.
 * Docker disregards leading/trailing slashes, supports `**`, and applies the
 * last matching (including negated) rule.
 */
const compileDockerIgnoreRule = (raw: string): DockerIgnoreRule | undefined => {
  let pattern = raw.trim();
  if (pattern.length === 0 || pattern === "." || pattern.startsWith("#")) {
    return undefined;
  }

  let ignored = true;
  if (pattern.startsWith("\\!") || pattern.startsWith("\\#")) {
    pattern = pattern.slice(1);
  } else if (pattern.startsWith("!")) {
    ignored = false;
    pattern = pattern.slice(1).trim();
  }

  pattern = normalizeRelativePath(pattern)
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  if (pattern.length === 0 || pattern === ".") {
    return undefined;
  }

  const hasSlash = pattern.includes("/");
  let body = "";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        while (pattern[index + 1] === "*") index++;
        if (pattern[index + 1] === "/") {
          index++;
          body += "(?:.*/)?";
        } else {
          body += ".*";
        }
      } else {
        body += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      body += "[^/]";
      continue;
    }
    if (char === "[") {
      const end = pattern.indexOf("]", index + 1);
      if (end !== -1) {
        const content = pattern.slice(index + 1, end);
        const negated = content.startsWith("!") || content.startsWith("^");
        const members = negated ? content.slice(1) : content;
        body += `[${negated ? "^" : ""}${members.replaceAll("\\", "\\\\")}]`;
        index = end;
        continue;
      }
    }
    body += escapeRegExp(char);
  }

  return {
    ignored,
    expression: new RegExp(`${hasSlash ? "^" : "(?:^|/)"}${body}(?:/.*)?$`),
  };
};

const isIgnored = (path: string, rules: ReadonlyArray<DockerIgnoreRule>) => {
  let ignored = false;
  for (const rule of rules) {
    if (rule.expression.test(path)) {
      ignored = rule.ignored;
    }
  }
  return ignored;
};

const resolveBuildInputs = Effect.fn(function* (source: FunctionImageSource) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const context = path.resolve(source.context);
  const dockerfile = source.dockerfile
    ? path.isAbsolute(source.dockerfile)
      ? source.dockerfile
      : path.resolve(context, source.dockerfile)
    : path.join(context, "Dockerfile");

  if (!(yield* fs.exists(context))) {
    return yield* Effect.die(
      new Error(`Docker build context does not exist: ${context}`),
    );
  }
  if (!(yield* fs.exists(dockerfile))) {
    return yield* Effect.die(
      new Error(`Dockerfile does not exist: ${dockerfile}`),
    );
  }

  // A Dockerfile-specific ignore file takes precedence over the context-root
  // `.dockerignore`, matching Docker's own build-context selection.
  const dockerfileIgnore = `${dockerfile}.dockerignore`;
  const rootIgnore = path.join(context, ".dockerignore");
  const ignoreFile = (yield* fs.exists(dockerfileIgnore))
    ? dockerfileIgnore
    : (yield* fs.exists(rootIgnore))
      ? rootIgnore
      : undefined;
  const ignoreContent =
    ignoreFile === undefined ? undefined : yield* fs.readFileString(ignoreFile);
  const rules = (ignoreContent ?? "").split(/\r?\n/).flatMap((line) => {
    const rule = compileDockerIgnoreRule(line);
    return rule ? [rule] : [];
  });

  return {
    context,
    dockerfile,
    dockerfileContent: yield* fs.readFile(dockerfile),
    ignoreContent,
    ignoreFile:
      ignoreFile === undefined ? undefined : path.basename(ignoreFile),
    rules,
  };
});

/**
 * Hash the effective Docker build input without absolute paths. Ignored
 * context files do not participate; Dockerfile contents, selected
 * `.dockerignore`, build args, target platform, file modes, symlink targets,
 * and the builder-version salt do.
 */
export const hashFunctionImageBuild = Effect.fn(function* (
  source: FunctionImageSource,
  architecture: "x86_64" | "arm64" = "x86_64",
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const inputs = yield* resolveBuildInputs(source);
  const hasher = yield* Effect.sync(() => crypto.createHash("sha256"));

  yield* Effect.sync(() => {
    hasher.update(
      JSON.stringify({
        builderVersion: functionImageBuilderVersion,
        platform: functionImagePlatform(architecture),
        buildArgs: Object.entries(source.buildArgs ?? {}).sort(([a], [b]) =>
          a.localeCompare(b),
        ),
        ignoreFile: inputs.ignoreFile,
        ignoreContent: inputs.ignoreContent,
      }),
    );
    hasher.update("\0Dockerfile\0");
    hasher.update(inputs.dockerfileContent);
  });

  const entries = yield* fs.readDirectory(inputs.context, { recursive: true });
  for (const entry of entries.map(normalizeRelativePath).sort()) {
    if (entry === inputs.ignoreFile || isIgnored(entry, inputs.rules)) {
      continue;
    }
    const fullPath = path.join(inputs.context, entry);
    const linkTarget = yield* fs
      .readLink(fullPath)
      .pipe(Effect.catch(() => Effect.succeed(undefined)));
    if (linkTarget !== undefined) {
      yield* Effect.sync(() => {
        hasher.update(`\0SymbolicLink\0${entry}\0${linkTarget}`);
      });
      continue;
    }

    const info = yield* fs.stat(fullPath);
    yield* Effect.sync(() => {
      hasher.update(`\0${info.type}\0${entry}\0${info.mode & 0o777}`);
    });
    if (info.type === "File") {
      const content = yield* fs.readFile(fullPath);
      yield* Effect.sync(() => {
        hasher.update("\0");
        hasher.update(content);
      });
    }
  }

  return (yield* Effect.sync(() => hasher.digest("hex"))).slice(0, 32);
});

const assertLiteralImageSource = (
  id: string,
  source: FunctionImageSource,
): Effect.Effect<void> => {
  const invalid =
    typeof source !== "object" ||
    source === null ||
    typeof source.context !== "string" ||
    (source.dockerfile !== undefined &&
      typeof source.dockerfile !== "string") ||
    (source.buildArgs !== undefined &&
      (typeof source.buildArgs !== "object" ||
        source.buildArgs === null ||
        Object.values(source.buildArgs).some(
          (value) => typeof value !== "string",
        )));
  return invalid
    ? Effect.die(
        new Error(
          `Function(${id}): image.context, image.dockerfile, and image.buildArgs must be literal values because the image is built during pre-create`,
        ),
      )
    : Effect.void;
};

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
    yield* ecr.setRepositoryPolicy({
      repositoryName,
      policyText: JSON.stringify({
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
      }),
    });

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
    yield* assertLiteralImageSource(id, source);
    return yield* hashFunctionImageBuild(source, architecture);
  });

  const resolve = Effect.fn(function* (options: ResolveFunctionImageOptions) {
    yield* assertLiteralImageSource(options.id, options.source);
    const repositoryName =
      options.repositoryName ?? (yield* createRepositoryName(options.id));
    // Re-ensure even with persisted metadata: the repository or its Lambda
    // pull policy may have drifted out-of-band.
    const ensured = yield* ensureRepository(options.id, repositoryName);
    const imageTag = yield* hash(
      options.id,
      options.source,
      options.architecture,
    );
    const imageUri = `${ensured.repositoryUri}:${imageTag}`;

    let detail = yield* describeImage(repositoryName, imageTag);
    if (!detail?.imageDigest) {
      const build = yield* resolveBuildInputs(options.source);
      yield* options.session.note(`Building Lambda image ${imageUri}...`);
      yield* buildAndPushEcrImage(docker, {
        imageUri,
        context: build.context,
        dockerfile: build.dockerfile,
        platform: functionImagePlatform(options.architecture),
        buildArgs: options.source.buildArgs,
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

  return { hash, resolve, deleteRepository };
});

export interface FunctionImage extends Effect.Success<
  typeof makeFunctionImage
> {}
