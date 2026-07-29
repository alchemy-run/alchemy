import * as Layer from "effect/Layer";
import { makeExecClient, makeLocalDiskBinding } from "./DiskBinding.ts";
import { Exec } from "./Exec.ts";

/**
 * Current-credentials implementation of the {@link Exec} binding — runs on
 * the ambient deploy-time API key (profile / `ARCHIL_API_KEY`) and registers
 * no binding. For scripts, Actions, and tests.
 */
export const ExecLocal = Layer.effect(
  Exec,
  makeLocalDiskBinding("Archil.Exec", makeExecClient),
);
