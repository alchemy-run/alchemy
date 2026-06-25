import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { Docker } from "./Docker.ts";

export interface RemoteImageProps {
  /** Docker image name, without tag. */
  name: string;
  /** Docker image tag. @default "latest" */
  tag?: string;
  /** Pull for this platform. */
  platform?: string;
  /**
   * Pull even when an image with the same reference already exists locally.
   *
   * @default true
   */
  alwaysPull?: boolean;
}

export interface RemoteImage extends Resource<
  "Docker.RemoteImage",
  RemoteImageProps,
  {
    /** Full image reference. */
    imageRef: string;
    /** Local image id after pull when available. */
    imageId?: string;
    /** Pull timestamp in milliseconds since epoch. */
    createdAt: number;
    /** Image name. */
    name: string;
    /** Image tag. */
    tag: string;
  }
> {}

/**
 * Pulls a remote Docker image through the active Docker context.
 *
 * The image is available to other Docker resources by `imageRef`. Use
 * `alwaysPull: false` when you want to reuse an existing tag in the configured
 * Docker daemon instead of pulling on every deploy.
 *
 * @resource
 *
 * @section Pulling Images
 * @example Pull nginx
 * ```typescript
 * const nginx = yield* Docker.RemoteImage("nginx", {
 *   name: "nginx",
 *   tag: "alpine",
 * });
 * ```
 *
 * @example Reuse an existing daemon tag
 * ```typescript
 * const postgres = yield* Docker.RemoteImage("postgres", {
 *   name: "postgres",
 *   tag: "18-alpine",
 *   alwaysPull: false,
 * });
 * ```
 */
export const RemoteImage = Resource<RemoteImage>("Docker.RemoteImage");

export const RemoteImageProvider = () =>
  Provider.effect(
    RemoteImage,
    Effect.gen(function* () {
      const docker = yield* Docker;

      return RemoteImage.Provider.of({
        list: () => Effect.succeed([]),
        read: Effect.fn(function* ({ olds, output }) {
          const ref = output?.imageRef ?? remoteImageRef(olds);
          return yield* docker.image.inspect(ref).pipe(
            Effect.map((image) => ({
              imageRef: ref,
              imageId: image.Id,
              createdAt: output?.createdAt ?? Date.parse(image.Created ?? ""),
              name: olds.name,
              tag: olds.tag ?? "latest",
            })),
            Effect.catchReason(
              "PlatformError",
              "NotFound",
              () => Effect.undefined,
            ),
          );
        }),
        diff: Effect.fn(function* ({ output, news }) {
          if (!isResolved(news)) return undefined;
          if (
            !output ||
            news.alwaysPull !== false ||
            output.imageRef !== remoteImageRef(news)
          ) {
            return { action: "update" };
          }
        }),
        reconcile: Effect.fn(function* ({ news, session }) {
          const ref = remoteImageRef(news);
          yield* session.note(`Pulling Docker image: ${ref}`);
          yield* docker.image.pull(ref, news.platform);
          const inspected = yield* docker.image.inspect(ref);
          return {
            imageRef: ref,
            imageId: inspected.Id,
            createdAt: Date.parse(inspected.Created ?? ""),
            name: news.name,
            tag: news.tag ?? "latest",
          };
        }),
        delete: Effect.fn(function* () {
          // Remote images are not removed on destroy because tags may be shared by
          // unrelated local stacks or developer workflows.
        }),
      });
    }),
  );

export const remoteImageRef = (props: RemoteImageProps): string =>
  `${props.name}:${props.tag ?? "latest"}`;
