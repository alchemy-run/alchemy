import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { AlchemyContext } from "../AlchemyContext.ts";
import { sha256Object } from "../Util/sha256.ts";
import { hashDockerBuildInputs, resolveDockerBuildPaths } from "./BuildHash.ts";
import { isInlineDockerfile, type InlineDockerfile } from "./Dockerfile.ts";

/** Dockerfile build inputs, shared by standalone and generated images. */
export interface DockerBuildOptions {
  /** Build context directory. Defaults to the working directory for file builds. */
  context?: string;
  /** Dockerfile path relative to context, or inline content. Defaults to `Dockerfile`. */
  dockerfile?: string | InlineDockerfile;
  /** Files in a generated context, exclusive with a filesystem context. */
  files?: Array<{
    /** Relative path inside the generated context. */
    path: string;
    /** File contents. */
    content: string | Uint8Array;
    /** File permissions. @default 420 */
    mode?: number;
  }>;
  /** Target platform. Defaults to Linux with the current machine architecture. */
  platform?: string;
  /** Docker build arguments. */
  args?: Record<string, string>;
  /** Multi-stage build target. */
  target?: string;
  /** Build cache import sources. */
  cacheFrom?: string[];
  /** Build cache export destinations. */
  cacheTo?: string[];
  /** Additional Docker build options. Included in the input hash. */
  options?: string[];
  /** Explicit invalidation for dependencies outside the build context. */
  extraHash?: string;
}

/** Hash and prepare Docker inputs without executing a Docker build. */
export const prepareImageBuild = Effect.fn(function* (
  build: DockerBuildOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform =
    build.platform ??
    (yield* Effect.sync(
      () => `linux/${process.arch === "arm64" ? "arm64" : "amd64"}`,
    ));
  let context: string;
  let dockerfile: string;
  if (build.dockerfile !== undefined && isInlineDockerfile(build.dockerfile)) {
    if (build.context !== undefined)
      return yield* Effect.fail(
        new Error(
          "Inline Dockerfiles use generated files, not a filesystem context",
        ),
      );
    const content = build.dockerfile.content;
    if (typeof content !== "string")
      return yield* Effect.fail(
        new Error(
          "Dockerfile inputs must be resolved before preparing an image",
        ),
      );
    const files = [...(build.files ?? [])].sort((a, b) =>
      a.path.localeCompare(b.path),
    );
    const seen = new Set<string>();
    for (const file of files) {
      const normalized = path.normalize(file.path);
      if (
        path.isAbsolute(normalized) ||
        normalized === ".." ||
        normalized.startsWith(`..${path.sep}`) ||
        normalized === "Dockerfile" ||
        seen.has(normalized)
      ) {
        return yield* Effect.fail(
          new Error(`Invalid generated image path: ${file.path}`),
        );
      }
      seen.add(normalized);
    }
    const key = yield* sha256Object({ dockerfile: content, files });
    const { dotAlchemy } = yield* AlchemyContext;
    context = path.resolve(dotAlchemy, "docker", "contexts", key);
    dockerfile = path.join(context, "Dockerfile");
    yield* fs.makeDirectory(context, { recursive: true });
    yield* fs.writeFileString(dockerfile, content);
    for (const file of files) {
      const filename = path.join(context, file.path);
      yield* fs.makeDirectory(path.dirname(filename), { recursive: true });
      yield* typeof file.content === "string"
        ? fs.writeFileString(filename, file.content)
        : fs.writeFile(filename, file.content);
      yield* fs.chmod(filename, file.mode ?? 0o644);
    }
  } else {
    if (build.files !== undefined)
      return yield* Effect.fail(
        new Error("Generated files require an inline Dockerfile"),
      );
    ({ context, dockerfile } = yield* resolveDockerBuildPaths({
      context: build.context ?? ".",
      dockerfile: build.dockerfile ?? "Dockerfile",
    }));
  }
  const contentHash = yield* hashDockerBuildInputs(
    { context, dockerfile, platform, buildArgs: build.args },
    "effective",
  );
  const hash = yield* sha256Object({
    contentHash,
    target: build.target,
    options: build.options,
    extraHash: build.extraHash,
  });
  return { context, dockerfile, platform, hash };
});
