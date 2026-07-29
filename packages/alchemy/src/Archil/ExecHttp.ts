import * as Layer from "effect/Layer";
import { makeExecClient, makeHttpDiskBinding } from "./DiskBinding.ts";
import { Exec } from "./Exec.ts";

/**
 * Token-scoped implementation of the {@link Exec} binding.
 *
 * Mints a dedicated `Archil.ApiToken` for the host and binds its value as a
 * secret (secret binding on Workers, env var on Lambda/ECS), so the deployed
 * code authenticates with its own revocable token. Works on any Alchemy host.
 */
export const ExecHttp = Layer.effect(
  Exec,
  makeHttpDiskBinding("Archil.Exec", makeExecClient),
);
