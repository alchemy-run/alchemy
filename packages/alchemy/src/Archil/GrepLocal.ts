import * as Layer from "effect/Layer";
import { makeGrepClient, makeLocalDiskBinding } from "./DiskBinding.ts";
import { Grep } from "./Grep.ts";

/**
 * Current-credentials implementation of the {@link Grep} binding — runs on
 * the ambient deploy-time API key and registers no binding.
 */
export const GrepLocal = Layer.effect(
  Grep,
  makeLocalDiskBinding("Archil.Grep", makeGrepClient),
);
