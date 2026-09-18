import * as Effect from "effect/Effect";
import * as Config from "effect/Config";
import type { Input } from "../../Input.ts";
import type * as Redacted from "effect/Redacted";
import * as Output from "../../Output.ts";
import * as Namespace from "../../Namespace.ts";
import { Stack } from "../../Stack.ts";
import { Image, isImageSource } from "../../Docker/Image.ts";
import {
  RemoteImage,
  isRemoteImageSource,
  type RemoteImageOptions,
} from "../../Docker/RemoteImage.ts";
import { isInlineDockerfile } from "../../Docker/Dockerfile.ts";
import { repositoryFromImageRef } from "../../Docker/Registry.ts";
import { sha256Object } from "../../Util/sha256.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { AnyContainerApplicationProps } from "./ContainerApplication.ts";
import {
  buildFinalDockerfile,
  bundleContainerProgram,
  validateContainerImageProps,
} from "./ContainerBundle.ts";

const imageInput = Effect.fn(function* (value: Input<string>) {
  if (Output.isOutput(value)) return value.as<string>();
  if (Config.isConfig(value)) return Output.asOutput(yield* value);
  if (Effect.isEffect(value)) return Output.asOutput(yield* value);
  return Output.asOutput(value);
});

/** Compose image resources while registering the container, before planning. */
export const composeContainerImage = Effect.fn(function* (
  id: string,
  props: AnyContainerApplicationProps,
) {
  if (
    globalThis.__ALCHEMY_RUNTIME__ ||
    props === undefined ||
    props.imageArtifact
  )
    return props;
  if (!props.main && (props.baseImage || props.bundle || props.publish))
    return yield* Effect.fail(
      new Error(
        "baseImage, bundle, and publish configure a generated program image; use Docker.Image or Docker.RemoteImage for finished images",
      ),
    );
  if (props.baseImage && props.image)
    return yield* Effect.fail(
      new Error(
        "Declare baseImage rather than combining it with the legacy image base",
      ),
    );
  if (props.bundle && props.build)
    return yield* Effect.fail(
      new Error(
        "Declare bundle rather than combining it with the legacy build bundler options",
      ),
    );
  const normalized = props.main
    ? {
        ...props,
        image: props.baseImage ?? props.image,
        build: props.bundle ?? props.build,
      }
    : props;
  yield* validateContainerImageProps(normalized);
  const { accountId } = yield* yield* CloudflareEnvironment;
  const stack = yield* Stack;
  const suffix = (yield* sha256Object({
    stack: stack.name,
    stage: stack.stage,
  })).slice(0, 12);
  const defaultName = `alchemy-${suffix}-containers`;
  const registry = props.registryId ?? "registry.cloudflare.com";
  const repository = `${registry}/${accountId}/${defaultName}`;
  const publish = props.publish ?? { repository };

  const image = yield* Namespace.push(
    id,
    Effect.gen(function* () {
      const imageSource = normalized.image;
      if (
        normalized.main &&
        (isImageSource(imageSource) || isRemoteImageSource(imageSource))
      )
        return yield* Effect.fail(
          new Error(
            "Image descriptors describe finished images; use baseImage with main",
          ),
        );
      if (isImageSource(imageSource)) {
        const {
          _tag,
          publish: destination,
          dockerContext,
          ...build
        } = imageSource;
        return yield* Image("Image", {
          build: { ...build, platform: build.platform ?? "linux/amd64" },
          publish: destination ?? publish,
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
                (isRemoteImageSource(imageSource) ? undefined : imageSource) ??
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
        const options: RemoteImageOptions = isRemoteImageSource(imageSource)
          ? imageSource
          : { source: imageSource };
        const source = Output.asOutput(options.source).pipe(
          Output.map((reference) => {
            if (
              registry !== "registry.cloudflare.com" ||
              !reference.startsWith(`${registry}/`)
            )
              return reference;
            const rest = reference.slice(registry.length + 1);
            return /^[a-f0-9]{32}\//.test(rest)
              ? reference
              : `${registry}/${accountId}/${rest}`;
          }),
        );
        return yield* RemoteImage("Image", {
          source,
          platform: options.platform ?? "linux/amd64",
          dockerContext: options.dockerContext,
          alwaysPull: options.alwaysPull,
          publish: options.publish ?? {
            ...publish,
            repository: source.pipe(
              Output.map((reference) =>
                reference.startsWith(`${registry}/`)
                  ? repositoryFromImageRef(reference)
                  : publish.repository,
              ),
            ),
          },
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
    return yield* Effect.fail(
      new Error("Container image resource has not resolved"),
    );
  }
  const digest = artifact.ref.split("@")[1];
  if (!local && !digest)
    return yield* Effect.fail(
      new Error("Cloudflare containers require a published image digest"),
    );
  return {
    imageRef: artifact.ref,
    imageHash: artifact.hash ?? (yield* sha256Object({ ref: artifact.ref })),
    digest,
    dev: local
      ? { tag: artifact.ref, localBuild: artifact.localBuild, env }
      : { imageUri: artifact.ref, env },
  };
});
