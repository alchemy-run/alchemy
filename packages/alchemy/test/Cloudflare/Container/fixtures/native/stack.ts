import * as Effect from "effect/Effect";
import * as Cloudflare from "@/Cloudflare";
import type { NativeAsyncObject } from "./async-worker.ts";
import { NativeImages } from "./images.ts";
import { NativeImage } from "./object.ts";
import { NativeWorker } from "./worker.ts";

export { NativeImages } from "./images.ts";

export const NativeAsyncImage = Cloudflare.Container<NativeAsyncObject>(
  "SANDBOX",
  Effect.map(NativeImages, (images) => ({
    className: "NativeAsyncObject",
    schedulingPolicy: "durable_object",
    images,
  })),
);

export const NativeAsyncWorker = Cloudflare.Worker(
  "NativeAsyncWorker",
  Effect.map(NativeImages, (images) => ({
    main: `${import.meta.dirname}/async-worker.ts`,
    env: { SANDBOX: NativeAsyncImage, IMAGE_REVISION: JSON.stringify(images) },
  })),
);

export const nativeStack = Effect.gen(function* () {
  return {
    worker: yield* NativeWorker,
    asyncWorker: yield* NativeAsyncWorker,
    application: yield* NativeImage.Application,
    asyncApplication: yield* NativeAsyncImage.Application,
  };
});
