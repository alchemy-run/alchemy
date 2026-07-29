import * as Layer from "effect/Layer";
import { makeGrepClient, makeHttpDiskBinding } from "./DiskBinding.ts";
import { Grep } from "./Grep.ts";

/**
 * Token-scoped implementation of the {@link Grep} binding — mints a
 * dedicated `Archil.ApiToken` for the host. Works on any Alchemy host.
 */
export const GrepHttp = Layer.effect(
  Grep,
  makeHttpDiskBinding("Archil.Grep", makeGrepClient),
);
