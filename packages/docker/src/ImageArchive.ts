/**
 * Image archives: a Docker build context built for one platform and saved
 * with `docker save`, for hosts with no registry between the deploy and the
 * machine that runs it (a VM that loads the archive into its own Docker).
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { hashDockerBuildInputs, resolveDockerBuildPaths } from "./BuildHash.ts";
import { Docker } from "./Docker.ts";

export interface ImageArchiveSource {
  /** The Docker build context directory. */
  context: string;
  /**
   * The Dockerfile, relative to the context unless absolute.
   * @default "Dockerfile"
   */
  dockerfile?: string;
  /** The platform the archive's image is built for, e.g. `linux/amd64`. */
  platform: string;
}

const pathsOf = Effect.fn(function* (source: ImageArchiveSource) {
  const path = yield* Path.Path;
  const dockerfile =
    source.dockerfile === undefined
      ? path.join(source.context, "Dockerfile")
      : path.isAbsolute(source.dockerfile)
        ? source.dockerfile
        : path.join(source.context, source.dockerfile);
  return yield* resolveDockerBuildPaths({ context: source.context, dockerfile });
});

/**
 * A content hash of the inputs an archive is built from: the context's
 * files (after `.dockerignore`), the Dockerfile and the platform. It
 * changes exactly when the archive's image would.
 */
export const hashImageArchive = Effect.fn(function* (source: ImageArchiveSource) {
  const { context, dockerfile } = yield* pathsOf(source);
  return yield* hashDockerBuildInputs(
    { context, dockerfile, platform: source.platform },
    "effective",
  );
});

/**
 * Build `source` and save its image to an archive at `output`, tagged
 * `tag`, the name `docker load` reports where the archive is loaded.
 * Resolves to the archive's bytes.
 */
export const buildImageArchive = Effect.fn(function* (
  source: ImageArchiveSource,
  options: { readonly tag: string; readonly output: string },
) {
  const docker = yield* Docker;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { context, dockerfile } = yield* pathsOf(source);
  yield* docker.image.build({
    context,
    file: dockerfile,
    tag: options.tag,
    platform: source.platform,
  });
  yield* fs.makeDirectory(path.dirname(options.output), { recursive: true });
  yield* docker.run(["save", options.tag, "-o", options.output]);
  return yield* fs.readFile(options.output);
});

/**
 * Shell lines that load the archive at `archive` into Docker and set the
 * shell variable `IMAGE` to the image it holds.
 */
export const loadImageArchiveScript = (archive: string) =>
  `IMAGE="$(docker load -i ${archive} | sed -n 's/^Loaded image: //p' | tail -1)"`;
