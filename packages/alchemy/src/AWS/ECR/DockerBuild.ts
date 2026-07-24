import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as crypto from "node:crypto";

export interface DockerBuildSource {
  context: string;
  dockerfile: string;
  platform: string;
  buildArgs?: Record<string, string>;
}

/**
 * Resolve and validate a Docker build context and Dockerfile.
 *
 * Dockerfile paths are relative to the build context unless absolute.
 */
export const resolveDockerBuildPaths = Effect.fn(function* (
  source: Pick<DockerBuildSource, "context" | "dockerfile">,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const context = path.resolve(source.context);
  const dockerfile = path.isAbsolute(source.dockerfile)
    ? source.dockerfile
    : path.resolve(context, source.dockerfile);

  if (!(yield* fs.exists(context))) {
    return yield* Effect.fail(
      new Error(`Docker build context does not exist: ${context}`),
    );
  }
  if (!(yield* fs.exists(dockerfile))) {
    return yield* Effect.fail(
      new Error(`Dockerfile does not exist: ${dockerfile}`),
    );
  }

  return { context, dockerfile };
});

/**
 * Hash every file in a Docker build context together with the Dockerfile,
 * platform, and build arguments. Absolute paths do not participate.
 */
export const hashDockerBuildInputs = Effect.fn(function* (
  source: DockerBuildSource,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { context, dockerfile } = yield* resolveDockerBuildPaths(source);
  const hasher = yield* Effect.sync(() => crypto.createHash("sha256"));

  yield* Effect.sync(() =>
    hasher.update(
      JSON.stringify({
        platform: source.platform,
        buildArgs: Object.entries(source.buildArgs ?? {}).sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0,
        ),
      }),
    ),
  );

  const dockerfileContent = yield* fs.readFile(dockerfile);
  yield* Effect.sync(() => {
    hasher.update("Dockerfile\0");
    hasher.update(dockerfileContent);
  });

  const entries = yield* fs.readDirectory(context, { recursive: true });
  const files = yield* Effect.forEach(
    entries.sort(),
    Effect.fn(function* (entry) {
      const fullPath = path.join(context, entry);
      const info = yield* fs.stat(fullPath);
      if (info.type !== "File") {
        return undefined;
      }
      return {
        entry,
        content: yield* fs.readFile(fullPath),
      };
    }),
  );

  yield* Effect.sync(() => {
    for (const file of files) {
      if (file === undefined) {
        continue;
      }
      hasher.update(`${file.entry}\0`);
      hasher.update(file.content);
    }
  });

  return (yield* Effect.sync(() => hasher.digest("hex"))).slice(0, 32);
});
