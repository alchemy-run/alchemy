import * as DockerfileParser from "@alchemy.run/docker/DockerfileParser";
import * as image from "@distilled.cloud/modal/image";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { App } from "./App.ts";
import { makeModalBinding } from "./BindingHttp.ts";
import { CreateImage, type ImageBuildOptions, type ImagesClient } from "./CreateImage.ts";
import { buildImage, ImageBuildOps } from "./ImageBuild.ts";
import { operations } from "./internal.ts";

/** The operations the client calls, resolved by `ModalBindings.withCredentials`. */
const ImagesOps = operations({
  build: ImageBuildOps,
  getByTag: image.imageGetByTag,
  publish: image.publishImage,
  deleteName: image.deleteImageName,
  delete: image.deleteImage,
});

export type ImagesOps = Effect.Success<typeof ImagesOps>;

const toBytes = (data: string | Uint8Array) =>
  Effect.sync(() => (typeof data === "string" ? new TextEncoder().encode(data) : data));

/** Build one image from runtime options in `appId`. */
export const buildFromOptions = Effect.fn(function* (
  ops: ImageBuildOps,
  appId: string,
  options: ImageBuildOptions,
) {
  // Parsed to normalize it; Modal's builder rejects what it can't run.
  // (The plan-time capability check lives with BuildPlan, which imports the
  // bundler and so stays out of runtime bundles.)
  const parsed =
    options.dockerfile !== undefined
      ? yield* DockerfileParser.parse(options.dockerfile)
      : undefined;
  const dockerfile = parsed ? DockerfileParser.renderLines(parsed) : [];
  const extra = options.commands ?? [];
  const commands = [...dockerfile, ...extra];
  const contextFiles = yield* Effect.forEach(
    Object.entries(options.files ?? {}),
    ([filename, data]) => Effect.map(toBytes(data), (bytes) => ({ filename, data: bytes })),
  );
  const imageId = yield* buildImage(ops, appId, {
    dockerTag: options.dockerfile
      ? undefined
      : options.from
        ? undefined
        : (options.image ?? "debian:bookworm-slim"),
    baseImageId: options.dockerfile ? undefined : options.from?.imageId,
    commands,
    contextFiles,
    secretIds: options.secrets?.map((s) => s.secretId),
    gpu: options.gpu,
    forceBuild: options.force,
  });
  return { imageId };
});

/** An images client over an app id resolved per call. */
export const makeImagesClient = (
  appId: Effect.Effect<string>,
  ops: ImagesOps,
  environment: Effect.Effect<string | undefined> = Effect.undefined,
): ImagesClient => ({
  fromTag: (tag) =>
    Effect.gen(function* () {
      const env = yield* environment;
      const found = yield* ops
        .getByTag({ tag, environmentName: env ?? "" })
        .pipe(Effect.catchTag("ImageNotFound", () => Effect.undefined));
      return found?.imageId ? { imageId: found.imageId } : undefined;
    }),
  publish: (target, tag) =>
    Effect.gen(function* () {
      const env = yield* environment;
      yield* ops.publish({ imageId: target.imageId, tag, environmentName: env ?? "" });
    }),
  unpublish: (tag) =>
    Effect.gen(function* () {
      const env = yield* environment;
      // Modal deletes only an explicit `name:tag`; a bare name is `name:latest`.
      const named = /:[^/]*$/.test(tag) ? tag : `${tag}:latest`;
      yield* ops
        .deleteName({ tag: env ? `${env}/${named}` : named })
        .pipe(Effect.catchTag("ImageNotFound", () => Effect.void));
    }),
  build: (options) => Effect.flatMap(appId, (id) => buildFromOptions(ops.build, id, options)),
  delete: (target) =>
    ops.delete({ imageId: target.imageId }).pipe(
      Effect.catchTag("ImageNotFound", () => Effect.void),
      Effect.asVoid,
    ),
});

/**
 * {@link CreateImage} over Modal's API. Grants the host's identity (a scoped
 * `Modal.ServiceUser`) the `contributor` role on the App's environment.
 *
 * @layer
 * @product Image
 * @provides Modal.CreateImage
 */
export const CreateImageHttp = Layer.effect(
  CreateImage,
  makeModalBinding({
    tag: "Modal.CreateImage",
    operations: ImagesOps,
    role: "contributor",
    make: Effect.fn(function* (app: App, ops) {
      const appId = yield* app.appId;
      const environment = yield* app.environment;
      return makeImagesClient(appId, ops, environment);
    }),
  }),
);
