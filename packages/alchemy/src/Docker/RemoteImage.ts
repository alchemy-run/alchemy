import * as Effect from "effect/Effect";
import { deepEqual, isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { imageId, inspectImageInfo, pullImage } from "./DockerApi.ts";

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
    kind: "RemoteImage";
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

export const remoteImageRef = (props: RemoteImageProps): string =>
  `${props.name}:${props.tag ?? "latest"}`;

export const RemoteImageProvider = () =>
  Provider.succeed(RemoteImage, {
    list: () => Effect.succeed([]),
    read: Effect.fn(function* ({ olds, output }) {
      const ref = output?.imageRef ?? remoteImageRef(olds);
      const image = yield* inspectImageInfo(ref);
      if (!image) return undefined;
      return {
        kind: "RemoteImage" as const,
        imageRef: ref,
        imageId: image.Id,
        createdAt: output?.createdAt ?? Date.now(),
        name: olds.name,
        tag: olds.tag ?? "latest",
      };
    }),
    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news)) return undefined;
      if (!deepEqual(olds, news) || news.alwaysPull !== false) {
        return { action: "update" as const };
      }
    }),
    reconcile: Effect.fn(function* ({ news, session }) {
      const ref = remoteImageRef(news);
      yield* session.note(`Pulling Docker image: ${ref}`);
      yield* pullImage(ref, { platform: news.platform });
      return {
        kind: "RemoteImage" as const,
        imageRef: ref,
        imageId: yield* imageId(ref).pipe(
          Effect.catch(() => Effect.succeed(undefined)),
        ),
        createdAt: Date.now(),
        name: news.name,
        tag: news.tag ?? "latest",
      };
    }),
    delete: Effect.fn(function* () {
      // Remote images are not removed on destroy because tags may be shared by
      // unrelated local stacks or developer workflows.
    }),
  });
