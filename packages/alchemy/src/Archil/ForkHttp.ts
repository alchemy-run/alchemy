import * as Layer from "effect/Layer";
import { makeForkClient, makeHttpDiskBinding } from "./DiskBinding.ts";
import { Fork } from "./Fork.ts";

/**
 * Token-scoped implementation of the {@link Fork} binding — mints a
 * dedicated `Archil.ApiToken` for the host. Works on any Alchemy host.
 */
export const ForkHttp = Layer.effect(
  Fork,
  makeHttpDiskBinding("Archil.Fork", makeForkClient),
);
