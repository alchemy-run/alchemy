import type * as cf from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { Worker, WorkerEnvironment } from "../Workers/Worker.ts";
import { type Images as ImagesLike } from "./Images.ts";
import {
  ImagesBinding,
  ImagesError,
  type ImageTransformationResultClient,
  type ImageTransformerClient,
  type ImagesClient,
} from "./ImagesBinding.ts";

export const ImagesBindingLayer = Layer.effect(
  ImagesBinding,
  Effect.gen(function* () {
    const env = yield* WorkerEnvironment;
    const host = yield* Worker;

    return Effect.fn(function* (images: ImagesLike) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* host.bind(images.name, {
          bindings: [
            {
              type: "images",
              name: images.name,
            },
          ],
        });
      }

      const raw = Effect.sync(
        // this must be lazy because the WorkerEnvironment is not available yet
        () => (env as Record<string, cf.ImagesBinding>)[images.name]!,
      );

      return {
        raw,
        info: (stream, options) =>
          Effect.gen(function* () {
            const binding = yield* raw;
            const readable = yield* toCfReadable(stream);
            return yield* tryPromise(() => binding.info(readable, options));
          }),
        input: (stream, options) =>
          Effect.gen(function* () {
            const binding = yield* raw;
            const readable = yield* toCfReadable(stream);
            return wrapTransformer(binding.input(readable, options));
          }),
      } satisfies ImagesClient;
    });
  }),
);

const tryPromise = <T>(fn: () => Promise<T>): Effect.Effect<T, ImagesError> =>
  Effect.tryPromise({
    try: fn,
    catch: (error: any) =>
      new ImagesError({
        message: error?.message ?? "Unknown error",
        code: typeof error?.code === "number" ? error.code : undefined,
        cause: error,
      }),
  });

/**
 * Convert an Effect `Stream<Uint8Array>` into the `cf.ReadableStream<Uint8Array>`
 * shape that the Cloudflare Images runtime binding expects. The two
 * `ReadableStream` types only differ at the type level; at runtime they
 * are the same Web Streams API.
 */
const toCfReadable = <E, R>(
  stream: Stream.Stream<Uint8Array, E, R>,
): Effect.Effect<cf.ReadableStream<Uint8Array>, never, R> =>
  Stream.toReadableStreamEffect(stream).pipe(
    Effect.map((s) => s as unknown as cf.ReadableStream<Uint8Array>),
  );

const isTransformerClient = (image: unknown): image is ImageTransformerClient =>
  typeof image === "object" && image !== null && "raw" in image;

const wrapTransformer = (raw: cf.ImageTransformer): ImageTransformerClient => ({
  raw,
  transform: (transform) => wrapTransformer(raw.transform(transform)),
  draw: <E, R>(
    image: Stream.Stream<Uint8Array, E, R> | ImageTransformerClient,
    options?: cf.ImageDrawOptions,
  ): Effect.Effect<ImageTransformerClient, never, R> => {
    if (isTransformerClient(image)) {
      return Effect.succeed(wrapTransformer(raw.draw(image.raw, options)));
    }
    return toCfReadable(image).pipe(
      Effect.map((readable) => wrapTransformer(raw.draw(readable, options))),
    );
  },
  output: (options) =>
    tryPromise(() => raw.output(options)).pipe(Effect.map(wrapResult)),
});

const wrapResult = (
  raw: cf.ImageTransformationResult,
): ImageTransformationResultClient => ({
  raw,
  response: Effect.sync(() => raw.response()),
  contentType: Effect.sync(() => raw.contentType()),
  image: (options) => Effect.sync(() => raw.image(options)),
});
