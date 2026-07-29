import * as Layer from "effect/Layer";
import { makeForkClient, makeLocalDiskBinding } from "./DiskBinding.ts";
import { Fork } from "./Fork.ts";

/**
 * Current-credentials implementation of the {@link Fork} binding — runs on
 * the ambient deploy-time API key and registers no binding.
 */
export const ForkLocal = Layer.effect(
  Fork,
  makeLocalDiskBinding("Archil.Fork", makeForkClient),
);
