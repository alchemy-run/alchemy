import * as Layer from "effect/Layer";
import { Connect } from "./Connect.ts";
import { makeConnectionClient, makeLocalDiskBinding } from "./DiskBinding.ts";

/**
 * Current-credentials implementation of the {@link Connect} binding — runs
 * on the ambient deploy-time API key (profile / `ARCHIL_API_KEY`) and
 * registers no binding. For scripts, Actions, and tests.
 */
export const ConnectLocal = Layer.effect(
  Connect,
  makeLocalDiskBinding("Archil.Connect", makeConnectionClient),
);
