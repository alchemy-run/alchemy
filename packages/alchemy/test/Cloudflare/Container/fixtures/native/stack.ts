import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import type { NativeAsyncObject } from "./async-worker.ts";
import { NativeImage } from "./object.ts";
import { NativeWorker } from "./worker.ts";

export const NativeImages = Context.Reference<
  Record<string, Cloudflare.Containers.ContainerImageProps>
>("NativeImages", {
  defaultValue: () => ({ shell: { image: "alpine:3.21" } }),
});

export const NativeAsyncImage = Cloudflare.Container<NativeAsyncObject>(
  "SANDBOX",
  Effect.map(NativeImages, (images) => ({
    className: "NativeAsyncObject",
    schedulingPolicy: "durable_object",
    images,
  })),
);

export const NativeAsyncWorker = Cloudflare.Worker("NativeAsyncWorker", {
  main: `${import.meta.dirname}/async-worker.ts`,
  env: { SANDBOX: NativeAsyncImage },
});

export const nativeStack = Effect.gen(function* () {
  return {
    worker: yield* NativeWorker,
    asyncWorker: yield* NativeAsyncWorker,
    application: yield* NativeImage.Application,
    asyncApplication: yield* NativeAsyncImage.Application,
  };
});
