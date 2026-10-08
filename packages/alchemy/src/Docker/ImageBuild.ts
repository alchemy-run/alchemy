import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { AlchemyContext } from "../AlchemyContext.ts";
import { sha256Object } from "../Util/sha256.ts";
import { hashDockerBuildInputs, resolveDockerBuildPaths } from "./BuildHash.ts";
import { isInlineDockerfile, type InlineDockerfile } from "./Dockerfile.ts";
import {
  DockerBuildInputConflict,
  DockerBuildInputUnresolved,
  DockerGeneratedFileInvalid,
} from "./ImageError.ts";

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

/** Root directory holding one subdirectory of generated build contexts per owner. */
const generatedContextsRoot = Effect.gen(function* () {
  const path = yield* Path.Path;
  const { dotAlchemy } = yield* AlchemyContext;
  return path.resolve(dotAlchemy, "docker", "contexts");
});

/**
 * Remove an owner's generated build contexts, keeping `keep` (the context the
 * owner's current build uses) when given. Idempotent: a missing owner
 * directory or entry is not an error.
 */
export const pruneGeneratedContexts = Effect.fn(function* (owner: string, keep?: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.join(yield* generatedContextsRoot, owner);
  if (keep === undefined) return yield* fs.remove(dir, { recursive: true, force: true });
  const entries = yield* fs
    .readDirectory(dir)
    .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])));
  for (const entry of entries) {
    const candidate = path.join(dir, entry);
    if (candidate !== keep) yield* fs.remove(candidate, { recursive: true, force: true });
  }
});

/**
 * Hash and prepare Docker inputs without executing a Docker build. Inline
 * Dockerfiles are materialized under `.alchemy/docker/contexts/<owner>/<hash>`
 * so the owning resource can prune contexts its earlier inputs produced.
 */
export const prepareImageBuild = Effect.fn(function* (build: DockerBuildOptions, owner = "shared") {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform =
    build.platform ??
    (yield* Effect.sync(() => `linux/${process.arch === "arm64" ? "arm64" : "amd64"}`));
  let context: string;
  let dockerfile: string;
  if (build.dockerfile !== undefined && isInlineDockerfile(build.dockerfile)) {
    if (build.context !== undefined)
      return yield* Effect.fail(
        new DockerBuildInputConflict({
          message: "Inline Dockerfiles use generated files, not a filesystem context",
        }),
      );
    const content = build.dockerfile.content;
    if (typeof content !== "string")
      return yield* Effect.fail(
        new DockerBuildInputUnresolved({
          message: "Dockerfile inputs must be resolved before preparing an image",
        }),
      );
    const files = [...(build.files ?? [])].sort((a, b) => a.path.localeCompare(b.path));
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
        return yield* Effect.fail(new DockerGeneratedFileInvalid({ path: file.path }));
      }
      seen.add(normalized);
    }
    const key = yield* sha256Object({ dockerfile: content, files });
    context = path.join(yield* generatedContextsRoot, owner, key);
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
        new DockerBuildInputConflict({ message: "Generated files require an inline Dockerfile" }),
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
