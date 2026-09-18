import * as Effect from "effect/Effect";
import { Docker } from "./Docker.ts";
import { prepareImageBuild, type DockerBuildOptions } from "./ImageBuild.ts";
import { parseCreatedAt } from "./Registry.ts";

/** Serializable build inputs for refreshing a local image during development. */
export interface LocalImageBuild {
  readonly name: string;
  readonly build: DockerBuildOptions;
  readonly dockerContext?: string;
  readonly tag?: string;
}

/** Ensure a local build exists, shared by resource reconciliation and dev reloads. */
export const ensureLocalImage = Effect.fn(function* (
  source: LocalImageBuild,
  prepared?: Effect.Success<ReturnType<typeof prepareImageBuild>>,
) {
  const docker = yield* Docker;
  const build = prepared ?? (yield* prepareImageBuild(source.build));
  const inputRef = `${source.name}:${build.hash}`;
  const imageRef = `${source.name}:${source.tag ?? build.hash}`;
  let image = yield* docker.image
    .inspect(inputRef, source.dockerContext)
    .pipe(
      Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined),
    );
  if (!image) {
    yield* docker.image.build({
      context: build.context,
      file: build.dockerfile,
      platform: build.platform,
      target: source.build.target,
      "build-arg": source.build.args,
      args: source.build.options,
      engineContext: source.dockerContext,
      tag: inputRef,
      "cache-from": source.build.cacheFrom,
      "cache-to": source.build.cacheTo,
    });
    image = yield* docker.image.inspect(inputRef, source.dockerContext);
  }
  if (imageRef !== inputRef)
    yield* docker.image.tag(inputRef, imageRef, source.dockerContext);
  return {
    ref: image.Id,
    imageRef,
    imageId: image.Id,
    name: source.name,
    hash: build.hash,
    tag: source.tag ?? build.hash,
    builtAt: parseCreatedAt(image.Created),
    localBuild: {
      ...source,
      build: {
        ...source.build,
        context: build.context,
        dockerfile: build.dockerfile,
        files: undefined,
      },
    } satisfies LocalImageBuild,
  };
});
