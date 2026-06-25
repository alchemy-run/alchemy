import type * as cf from "@cloudflare/workers-types";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import { type Images as ImagesLike } from "./Images.ts";

export class ImagesError extends Data.TaggedError("ImagesError")<{
  message: string;
  code?: number;
  cause: unknown;
}> {}

/**
 * Effect-native handle to the result of `input(...).output(...)`.
 * Mirrors the runtime `ImageTransformationResult` but exposes side
 * effects (response/image/contentType reads) as plain sync effects.
 */
export interface ImageTransformationResultClient {
  raw: cf.ImageTransformationResult;
  response: Effect.Effect<cf.Response>;
  contentType: Effect.Effect<string>;
  image(
    options?: cf.ImageTransformationOutputOptions,
  ): Effect.Effect<cf.ReadableStream<Uint8Array>>;
}

/**
 * Effect-native chainable transformer. `transform`/`draw` are pure
 * (return a new client wrapping the next runtime transformer);
 * `output` is the only step that crosses into Cloudflare's runtime
 * and therefore returns an Effect.
 */
export interface ImageTransformerClient {
  raw: cf.ImageTransformer;
  transform(transform: cf.ImageTransform): ImageTransformerClient;
  draw<E = never, R = never>(
    image: Stream.Stream<Uint8Array, E, R> | ImageTransformerClient,
    options?: cf.ImageDrawOptions,
  ): Effect.Effect<ImageTransformerClient, never, R>;
  output(
    options: cf.ImageOutputOptions,
  ): Effect.Effect<ImageTransformationResultClient, ImagesError>;
}

/**
 * Effect-native client for a Cloudflare Images binding.
 *
 * Wraps the runtime {@link cf.ImagesBinding} so each method returns
 * an Effect tagged with {@link ImagesError}. Use
 * `Cloudflare.Images.bind(images)` inside a Worker's init phase.
 */
export interface ImagesClient {
  /** Effect resolving to the raw Cloudflare runtime binding. */
  raw: Effect.Effect<cf.ImagesBinding, never, RuntimeContext>;
  /**
   * Read image format and dimensions from a stream of bytes.
   * Fails with {@link ImagesError} (code 9412) if the input is not
   * a recognized image.
   */
  info<E = never, R = never>(
    stream: Stream.Stream<Uint8Array, E, R>,
    options?: cf.ImageInputOptions,
  ): Effect.Effect<cf.ImageInfoResponse, ImagesError, RuntimeContext | R>;
  /**
   * Begin a transformation pipeline. Subsequent `.transform()` /
   * `.draw()` calls are pure; `.output(opts)` runs the pipeline.
   */
  input<E = never, R = never>(
    stream: Stream.Stream<Uint8Array, E, R>,
    options?: cf.ImageInputOptions,
  ): Effect.Effect<ImageTransformerClient, never, RuntimeContext | R>;
}

/**
 * The Cloudflare Images runtime binding. A single identifier that is
 * simultaneously the binding's Context tag, its type, and the callable —
 * `yield* Cloudflare.Images(...)` resolves through this. Prefer yielding the
 * {@link ImagesLike} marker (`Cloudflare.Images({ name })`) directly.
 *
 * @binding
 * @product Images
 * @category Media
 */
export interface ImagesBinding extends Binding.Service<
  ImagesBinding,
  "Cloudflare.Images.Binding",
  (images: ImagesLike) => Effect.Effect<ImagesClient>
> {}

export const ImagesBinding = Binding.Service<ImagesBinding>(
  "Cloudflare.Images.Binding",
);
