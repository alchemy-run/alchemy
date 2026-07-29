import * as Layer from "effect/Layer";
import { Connect } from "./Connect.ts";
import { makeConnectionClient, makeHttpDiskBinding } from "./DiskBinding.ts";

/**
 * Token-scoped implementation of the {@link Connect} binding.
 *
 * Mints a dedicated `Archil.ApiToken` for the host and binds its value as a
 * secret (secret binding on Workers, env var on Lambda/ECS), so the deployed
 * code authenticates with its own revocable token. Works on any Alchemy host.
 */
export const ConnectHttp = Layer.effect(
  Connect,
  makeHttpDiskBinding("Archil.Connect", makeConnectionClient),
);
