import * as Effect from "effect/Effect";
import * as Cloudflare from "@/Cloudflare";
import { declareDurableObjectApplication } from "@/Cloudflare/Containers/DurableObjectApplication.ts";
import type { NativeAsyncObject } from "./async-worker.ts";
import { NativeImages } from "./images.ts";
import { NativeShell, NativeTools } from "./object.ts";
import { NativeWorker } from "./worker.ts";

export { NativeImages } from "./images.ts";

/** The async class's first image, keyed `AsyncShell` in `ctx.container.images`. */
export const AsyncShell = Cloudflare.Container<NativeAsyncObject>(
  "AsyncShell",
  Effect.map(NativeImages, ({ shell }) => ({
    className: "NativeAsyncObject",
    schedulingPolicy: "durable_object" as const,
    image: shell,
  })),
);

/** The async class's second image, keyed `AsyncTools`. */
export const AsyncTools = Cloudflare.Container<NativeAsyncObject>(
  "AsyncTools",
  Effect.map(NativeImages, ({ tools }) => ({
    className: "NativeAsyncObject",
    schedulingPolicy: "durable_object" as const,
    image: tools,
  })),
);

/** Two Containers share `NativeAsyncObject`; `tools: undefined` removes the second. */
export const NativeAsyncWorker = Cloudflare.Worker(
  "NativeAsyncWorker",
  Effect.map(NativeImages, (images) => ({
    main: `${import.meta.dirname}/async-worker.ts`,
    env: {
      SANDBOX: AsyncShell,
      ...(images.tools === undefined ? {} : { TOOLS: AsyncTools }),
      IMAGE_REVISION: JSON.stringify(images),
    },
  })),
);

export const nativeStack = Effect.gen(function* () {
  const worker = yield* NativeWorker;
  const asyncWorker = yield* NativeAsyncWorker;
  return {
    worker,
    asyncWorker,
    shell: yield* NativeShell.Application,
    tools: yield* NativeTools.Application,
    asyncShell: yield* AsyncShell.Application,
    // Each class's one container application, shared by its Containers.
    application: yield* declareDurableObjectApplication(worker, "NativeObject"),
    asyncApplication: yield* declareDurableObjectApplication(asyncWorker, "NativeAsyncObject"),
  };
});
