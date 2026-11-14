import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { App } from "./App.ts";
import type { buildFromOptions, ImagesOps } from "./CreateImageHttp.ts";
import type { ErrorOf, OpError } from "./internal.ts";

/** What to build: Modal's image inputs, in memory (no build context directory). */
export interface ImageBuildOptions {
  /** Start from a registry image. */
  readonly image?: string;
  /** Start from a Modal image (a deploy-time `Modal.Image`, or a snapshot). */
  readonly from?: { readonly imageId: string };
  /** A whole Dockerfile as text (`FROM` included). Exclusive with `image`/`from`. */
  readonly dockerfile?: string;
  /** Dockerfile lines appended to the build. */
  readonly commands?: ReadonlyArray<string>;
  /** Files the commands `COPY`, by path relative to the build context. */
  readonly files?: Record<string, string | Uint8Array>;
  /** Secrets the build steps see as environment variables. */
  readonly secrets?: ReadonlyArray<{ readonly secretId: string }>;
  /** Run the build on a GPU. */
  readonly gpu?: string;
  /** Rebuild even when Modal has the same image cached. */
  readonly force?: boolean;
}

/** Build images in one App at runtime. */
export interface ImagesClient {
  /**
   * Build an image (or return the cached one: Modal content-addresses
   * builds) and wait until it's ready. Fails with `Modal.ImageBuildFailed`.
   */
  build(
    options: ImageBuildOptions,
  ): Effect.Effect<{ readonly imageId: string }, ErrorOf<typeof buildFromOptions>, RuntimeContext>;
  /** The image published under `tag`, or `undefined`. */
  fromTag(
    tag: string,
  ): Effect.Effect<
    { readonly imageId: string } | undefined,
    OpError<ImagesOps, "getByTag">,
    RuntimeContext
  >;
  /** Publish an image under `tag` (moving the tag if it points elsewhere). */
  publish(
    image: { readonly imageId: string },
    tag: string,
  ): Effect.Effect<void, OpError<ImagesOps, "publish">, RuntimeContext>;
  /** Remove a published tag (`name` or `name:tag`); the image itself stays. */
  unpublish(tag: string): Effect.Effect<void, OpError<ImagesOps, "deleteName">, RuntimeContext>;
  /** Delete an image. */
  delete(image: {
    readonly imageId: string;
  }): Effect.Effect<void, OpError<ImagesOps, "delete">, RuntimeContext>;
}

/**
 * Build Modal Images at runtime, e.g. one per repository a user connects,
 * from the same inputs a `Modal.Image` takes. Modal builds remotely; the
 * runtime needs no Docker.
 *
 * ### An image per repository
 * **Example:** From a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Modal from "@alchemy.run/modal";
 * import * as Effect from "effect/Effect";
 * import * as Layer from "effect/Layer";
 * import { HttpServerRequest } from "effect/http/HttpServerRequest";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import { Coder } from "./Coder.ts";
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const images = yield* Modal.CreateImage(Coder);
 *     const sandboxes = yield* Modal.CreateSandbox(Coder);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const request = yield* HttpServerRequest;
 *         const repo = request.headers["x-repo"] ?? "alchemy-run/alchemy";
 *         const image = yield* images.build({
 *           image: "node:22-bookworm",
 *           commands: [`RUN git clone https://github.com/${repo} /work`],
 *         });
 *         const sandbox = yield* sandboxes.create({ image });
 *         return HttpServerResponse.text(sandbox.sandboxId);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Layer.mergeAll(Modal.CreateImageHttp, Modal.CreateSandboxHttp))),
 * ) {}
 * ```
 *
 * @binding
 * @product Image
 */
export interface CreateImage extends Binding.Service<
  CreateImage,
  "Modal.CreateImage",
  (app: App) => Effect.Effect<ImagesClient>
> {}

export const CreateImage = Binding.Service<CreateImage>("Modal.CreateImage");
