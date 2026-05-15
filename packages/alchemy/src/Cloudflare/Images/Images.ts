import * as Effect from "effect/Effect";
import { ImagesBinding } from "./ImagesBinding.ts";

type ImagesTypeId = typeof ImagesTypeId;
const ImagesTypeId = "Cloudflare.Images" as const;

export type ImagesProps = {
  /**
   * Binding name used when `Cloudflare.Images.bind(images)` attaches Images
   * from inside a Worker init phase. When Images is passed through
   * `Worker({ bindings: { ... } })`, the object key remains the binding name.
   *
   * @default "IMAGES"
   */
  name?: string;
};

/**
 * Marker for a Cloudflare Images binding.
 *
 * Images bindings are configured directly on Workers and do not have a
 * standalone provisioning API. The Worker provider sees this object in
 * `bindings: { ... }` and emits the corresponding `{ type: "images" }`
 * metadata binding to the script.
 */
export type Images = {
  kind: ImagesTypeId;
  name: string;
};

export const isImages = (value: unknown): value is Images =>
  typeof value === "object" &&
  value !== null &&
  "kind" in value &&
  (value as Images).kind === ImagesTypeId;

/**
 * A Cloudflare Images binding for image transformation and manipulation inside
 * Workers.
 *
 * The Effect-native interface (`Cloudflare.ImagesClient`) takes Effect
 * `Stream.Stream<Uint8Array>` inputs and returns `Effect`s — `info`,
 * `input(...).transform(...).draw(...).output(...)`. The runtime conversion
 * to Cloudflare's `ReadableStream` is handled internally.
 *
 * @section Declaring Images
 * @example
 * ```typescript
 * const Pipeline = yield* Cloudflare.Images({ name: "PIPELINE" });
 * ```
 *
 * @section Effect-style Worker (recommended)
 * @example Direct binding inside a Worker
 * ```typescript
 * const images = yield* Cloudflare.Images.bind(pipeline);
 *
 * const info = yield* images.info(request.stream);
 * ```
 *
 * @example Providing an Images client to a service
 * ```typescript
 * import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
 *
 * Cloudflare.Worker("ImageWorker", { main: import.meta.filename },
 *   Effect.gen(function* () {
 *     const pipeline = yield* Pipeline;
 *     const boundImages = yield* Cloudflare.Images.bind(pipeline);
 *
 *     class ImageInfo extends Context.Service<ImageInfo, {
 *       read(stream: Stream.Stream<Uint8Array>): Effect.Effect<ImageInfoResponse, Cloudflare.ImagesError>;
 *     }>()("ImageInfo") {}
 *
 *     const ImageInfoLive = Layer.effect(
 *       ImageInfo,
 *       Effect.gen(function* () {
 *         const images = yield* Cloudflare.ImagesClient;
 *         return {
 *           read: (stream) => images.info(stream),
 *         };
 *       }),
 *     ).pipe(
 *       Layer.provide(Cloudflare.ImagesClient.layer(boundImages)),
 *     );
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const request = yield* HttpServerRequest;
 *         const imageInfo = yield* ImageInfo;
 *         // request.stream is Stream.Stream<Uint8Array>
 *         const info = yield* imageInfo.read(request.stream);
 *         return yield* HttpServerResponse.json(info);
 *       }).pipe(Effect.provide(ImageInfoLive)),
 *     };
 *   }),
 * );
 * ```
 *
 * @example Transform an image — chainable pipeline, single Effect at the end
 * ```typescript
 * const result = yield* (yield* images.input(request.stream))
 *   .transform({ width: 128 })
 *   .output({ format: "image/jpeg" });
 *
 * const response = yield* result.response;
 * ```
 *
 * @section Binding to a Worker (declarative)
 * @example
 * ```typescript
 * export const Worker = Cloudflare.Worker("Worker", {
 *   main: "./src/worker.ts",
 *   bindings: { MEDIA: Pipeline },
 * });
 *
 * export type WorkerEnv = Cloudflare.InferEnv<typeof Worker>;
 * //   { MEDIA: ImagesBinding }
 * ```
 *
 * Inside the Worker, the raw Cloudflare runtime binding is reachable via
 * `client.raw` if you need to call `info()` / `input()` directly with
 * `async`/`await`. The Effect-native interface is preferred — it returns
 * tagged `ImagesError`s and lets you stream Effect `Stream<Uint8Array>`
 * sources without manual conversion.
 *
 * @see https://developers.cloudflare.com/images/transform-images/bindings/
 */
export const Images: {
  (props?: ImagesProps): Effect.Effect<Images>;
  /**
   * Bind Cloudflare Images to the surrounding Worker, returning an
   * Effect-native client with access to the native Workers runtime binding.
   */
  bind: typeof ImagesBinding.bind;
} = Object.assign(
  Effect.fn(function* (props?: ImagesProps) {
    return {
      kind: ImagesTypeId,
      name: props?.name ?? "IMAGES",
    } satisfies Images;
  }),
  {
    bind: (...args: Parameters<typeof ImagesBinding.bind>) =>
      ImagesBinding.bind(...args),
  },
);
