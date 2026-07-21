import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../Binding.ts";
import { ApiToken } from "./ApiToken.ts";
import { Client, type ClientOptions } from "./Client.ts";
import { authorizeWith, makeArchilClient } from "./RuntimeAuth.ts";

/**
 * HTTP-backed implementation of the {@link Client} binding.
 *
 * Mints a dedicated `Archil.ApiToken` for the host Function/Worker and binds
 * its value as a secret via the accessor machinery (secret binding on
 * Workers, env var on Lambda/ECS), so the deployed code authenticates with
 * its own revocable token. Works on any Alchemy host.
 *
 * The client's default region is the region the token was minted in (the
 * deploy-time credentials' default region) unless overridden per client via
 * `Archil.Client({ region })`.
 */
export const ClientHttp = Layer.effect(
  Client,
  Effect.gen(function* () {
    const Token = yield* ApiToken;
    return Effect.fn(function* (options?: ClientOptions) {
      // Binding.Host (requirement-free, unlike `Self`) resolves the host
      // Function/Worker on every platform — Lambda's `FunctionServices` does
      // not admit a `Self` requirement.
      const host = yield* Binding.Host;
      const token = yield* Token(`${host.LogicalId}ArchilToken`);
      const value = yield* token.value;
      const tokenRegion = yield* token.region;
      const region =
        options?.region !== undefined
          ? Effect.succeed(options.region)
          : tokenRegion;
      return makeArchilClient(authorizeWith(value), region);
    });
  }),
);
