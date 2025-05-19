import type { SerializedScope } from "../serde.js";

declare global {
  const __ALCHEMY_WORKER_NAME__: string;
  const __ALCHEMY_RUNTIME__: true;
  const __ALCHEMY_SERIALIZED_SCOPE__: SerializedScope;
}

// __ALCHEMY_SERIALIZED_SCOPE__ is injected by esbuild when bundling a Worker
export const isRuntime = typeof __ALCHEMY_RUNTIME__ !== "undefined";
