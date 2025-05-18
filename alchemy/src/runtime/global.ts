import type { SerializedScope } from "../serde.js";
import type { RuntimeState } from "./state.js";

declare global {
  const __ALCHEMY_SERIALIZED_SCOPE__: SerializedScope;
  const __ALCHEMY_STATE__: RuntimeState;
}

// __ALCHEMY_SERIALIZED_SCOPE__ is injected by esbuild when bundling a Worker
export const isRuntime = typeof __ALCHEMY_SERIALIZED_SCOPE__ !== "undefined";
