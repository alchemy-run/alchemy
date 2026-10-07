import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { isInlineDockerfile } from "../../Docker/Dockerfile.ts";
import { Image } from "../../Docker/Image.ts";
import type { ImageOptions, RemoteImageOptions } from "../../Docker/ImageOptions.ts";
import type { ImagePublish } from "../../Docker/ImageRegistry.ts";
import { repositoryFromImageRef } from "../../Docker/Registry.ts";
import { RemoteImage } from "../../Docker/RemoteImage.ts";
import type { Input } from "../../Input.ts";
import * as Namespace from "../../Namespace.ts";
import * as Output from "../../Output.ts";
import { defaultProviderMode } from "../../ProviderMode.ts";
import { Stack } from "../../Stack.ts";
import { sha256Object } from "../../Util/sha256.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import { localAccountId } from "../LocalAccount.ts";
import type { AnyContainerApplicationProps } from "./ContainerApplication.ts";
import {
  buildFinalDockerfile,
  bundleContainerProgram,
  validateContainerImageProps,
} from "./ContainerBundle.ts";
import {
  ContainerImageDigestMissing,
  ContainerImageSourceConflict,
  ContainerImageSourceMissing,
  ContainerImageUnresolved,
} from "./ContainerImageError.ts";

const imageInput = Effect.fn(function* (value: Input<string>) {
  if (Output.isOutput(value)) return value.as<string>();
  if (Config.isConfig(value)) return Output.asOutput(yield* value);
  if (Effect.isEffect(value)) return Output.asOutput(yield* value);
  return Output.asOutput(value);
});

const isImageOptions = (image: AnyContainerApplicationProps["image"]): image is ImageOptions =>
  typeof image === "object" &&
  image !== null &&
  !Output.isOutput(image) &&
  !Effect.isEffect(image) &&
  !Config.isConfig(image);

const isRemoteImageOptions = (image: ImageOptions): image is RemoteImageOptions => "ref" in image;

const MAX_REPOSITORY_NAME = 64;

/**
 * Default publication repository: one per container application, named
 * `<stack>-<namespace…>-<id>-<stage>`. It is deterministic (no instance
 * suffix) so it is known when the container registers and stays stable when
 * the application is replaced.
 */
const defaultRepositoryName = Effect.fn(function* (id: string) {
  const stack = yield* Stack;
  const chain = yield* Namespace.CurrentChain;
  const name = [stack.name, ...chain.toReversed(), id, stack.stage]
    .join("-")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
  if (name.length <= MAX_REPOSITORY_NAME) return name;
  const hash = (yield* sha256Object({ name })).slice(0, 12);
  return `${name.slice(0, MAX_REPOSITORY_NAME - hash.length - 1).replace(/-+$/, "")}-${hash}`;
});

/** Compose image resources while registering the container, before planning. */
export const composeContainerImage = Effect.fn(function* (
  id: string,
  props: AnyContainerApplicationProps,
) {
  if (globalThis.__ALCHEMY_RUNTIME__ || props === undefined || props.imageArtifact) return props;
  if (!props.main && (props.baseImage || props.bundle))
    return yield* Effect.fail(
      new ContainerImageSourceConflict({
        options: ["baseImage", "bundle", "main"],
        message:
          "baseImage and bundle configure a generated program image; use image: { context } or image: { ref } for finished images",
      }),
    );
  if (!props.main && props.publish && isImageOptions(props.image))
    return yield* Effect.fail(
      new ContainerImageSourceConflict({
        options: ["publish", "image"],
        message: "Declare publish inside image when using embedded image options",
      }),
    );
  if (props.baseImage && props.image)
    return yield* Effect.fail(
      new ContainerImageSourceConflict({
        options: ["baseImage", "image"],
        message: "Declare baseImage rather than combining it with the legacy image base",
      }),
    );
  if (props.bundle && props.build)
    return yield* Effect.fail(
      new ContainerImageSourceConflict({
        options: ["bundle", "build"],
        message: "Declare bundle rather than combining it with the legacy build bundler options",
      }),
    );
  const normalized = props.main
    ? {
        ...props,
        image: props.baseImage ?? props.image,
        build: props.bundle ?? props.build,
      }
    : props;
  yield* validateContainerImageProps(normalized);
  // Validate the image source before resolving accounts or registering children.
  const imageSource = normalized.image;
  if (isImageOptions(imageSource)) {
    if (normalized.main)
      return yield* Effect.fail(
        new ContainerImageSourceConflict({
          options: ["image", "main"],
          message: "image and main are mutually exclusive; use baseImage with main",
        }),
      );
    if (isRemoteImageOptions(imageSource)) {
      if (
        [
          "context",
          "dockerfile",
          "files",
          "args",
          "target",
          "cacheFrom",
          "cacheTo",
          "options",
          "extraHash",
        ].some((key) => key in imageSource)
      )
        return yield* Effect.fail(
          new ContainerImageSourceConflict({
            options: ["image.ref", "image.context", "image.dockerfile"],
            message: "image.ref cannot be combined with Dockerfile build inputs",
          }),
        );
    } else if (!("context" in imageSource) && !("dockerfile" in imageSource)) {
      return yield* Effect.fail(new ContainerImageSourceMissing({ id }));
    }
  }
  // Local images are never published, so dev must not require credentials.
  const accountId =
    (yield* defaultProviderMode) === "local"
      ? yield* localAccountId
      : (yield* yield* CloudflareEnvironment).accountId;
  const defaultName = yield* defaultRepositoryName(id);
  const registry = props.registryId ?? "registry.cloudflare.com";
  const repository = `${registry}/${accountId}/${defaultName}`;
  const qualifyRepository = (name: string) => {
    const host = name.split("/")[0]!;
    return name.includes("/") && (host.includes(".") || host.includes(":") || host === "localhost")
      ? name
      : `${registry}/${accountId}/${name}`;
  };
  const publication = Effect.fn(function* (destination?: ImagePublish) {
    const name = yield* imageInput(destination?.repository ?? repository);
    return {
      ...destination,
      repository: name.pipe(Output.map(qualifyRepository)),
    };
  });
  const publish = yield* publication(props.publish);

  const image = yield* Namespace.push(
    id,
    Effect.gen(function* () {
      if (isImageOptions(imageSource) && !isRemoteImageOptions(imageSource)) {
        const { publish: destination, dockerContext, ...build } = imageSource;
        return yield* Image("Image", {
          build: {
            ...build,
            platform: (yield* imageInput(build.platform ?? "linux/amd64")).pipe(
              Output.map((platform) => platform ?? "linux/amd64"),
            ),
          },
          publish: yield* publication(destination),
          dockerContext,
        }).pipe(
          Effect.map((image) => ({
            ref: image.ref,
            hash: image.hash,
            localBuild: image.localBuild,
          })),
        );
      }
      if (normalized.main) {
        const runtime = normalized.runtime ?? "bun";
        const bundle = yield* bundleContainerProgram({
          id,
          main: normalized.main,
          runtime,
          handler: normalized.handler,
          isExternal: normalized.isExternal,
          external: normalized.external,
          build: normalized.build,
        });
        const preamble =
          normalized.dockerfile && isInlineDockerfile(normalized.dockerfile)
            ? yield* imageInput(normalized.dockerfile.content)
            : Output.asOutput(
                (isImageOptions(imageSource) ? undefined : imageSource) ??
                  (runtime === "bun" ? "oven/bun:1" : "node:22-slim"),
              ).pipe(Output.map((base) => `FROM ${base}`));
        return yield* Image("Image", {
          build: {
            dockerfile: {
              content: preamble.pipe(
                Output.map((base) =>
                  buildFinalDockerfile(
                    base,
                    runtime,
                    normalized.external,
                    normalized.autoInstallExternals,
                  ),
                ),
              ),
            },
            files: bundle.files.map((file, index) => ({
              ...file,
              path: index === 0 ? "index.mjs" : file.path,
            })),
            platform: "linux/amd64",
          },
          publish,
        }).pipe(
          Effect.map((image) => ({
            ref: image.ref,
            hash: image.hash,
            localBuild: image.localBuild,
          })),
        );
      }
      if (imageSource) {
        const options: RemoteImageOptions = isImageOptions(imageSource)
          ? imageSource
          : { ref: imageSource };
        const source = (yield* imageInput(options.ref)).pipe(
          Output.map((reference) => {
            if (registry !== "registry.cloudflare.com" || !reference.startsWith(`${registry}/`))
              return reference;
            const rest = reference.slice(registry.length + 1);
            return /^[a-f0-9]{32}\//.test(rest) ? reference : `${registry}/${accountId}/${rest}`;
          }),
        );
        return yield* RemoteImage("Image", {
          source,
          platform: (yield* imageInput(options.platform ?? "linux/amd64")).pipe(
            Output.map((platform) => platform ?? "linux/amd64"),
          ),
          dockerContext: options.dockerContext,
          alwaysPull: options.alwaysPull,
          // Images already in the target registry keep their repository; a
          // top-level `publish` only selects where external images are mirrored.
          publish: options.publish
            ? yield* publication(options.publish)
            : Output.all(source, publish.repository).pipe(
                Output.map(([reference, destination]) => ({
                  ...publish,
                  repository: reference.startsWith(`${registry}/`)
                    ? repositoryFromImageRef(reference)
                    : destination,
                })),
              ),
        }).pipe(Effect.map((image) => ({ ref: image.ref, hash: image.hash })));
      }
      return yield* Image("Image", {
        build: {
          context: normalized.context,
          dockerfile: normalized.dockerfile,
          platform: "linux/amd64",
        },
        publish,
      }).pipe(
        Effect.map((image) => ({
          ref: image.ref,
          hash: image.hash,
          localBuild: image.localBuild,
        })),
      );
    }),
  );
  return { ...props, imageArtifact: image };
});

export const resolveContainerImage = Effect.fn(function* (
  props: AnyContainerApplicationProps,
  env: Record<string, string | Redacted.Redacted<string>>,
  local = false,
) {
  const artifact = props.imageArtifact;
  if (!artifact || typeof artifact.ref !== "string") {
    return yield* Effect.fail(new ContainerImageUnresolved());
  }
  const digest = artifact.ref.split("@")[1];
  if (!local && !digest)
    return yield* Effect.fail(new ContainerImageDigestMissing({ ref: artifact.ref }));
  return {
    imageRef: artifact.ref,
    imageHash: artifact.hash ?? (yield* sha256Object({ ref: artifact.ref })),
    digest,
    dev: local
      ? { tag: artifact.ref, localBuild: artifact.localBuild, env }
      : { imageUri: artifact.ref, env },
  };
});
