import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import {
  type FindIdentityProviderOptions,
  GetIdentityProvider,
} from "./GetIdentityProvider.ts";
import { findFirst, toAttributes } from "./IdentityProviderLookup.ts";

// Bespoke (not the shared *Http token scaffold): the lookup runs with the
// ambient plan-time credentials and there is no resource to bind — only
// filters. Registered by `Cloudflare.providers()` so the data-source form
// (`getIdentityProvider`) resolves during plan/deploy.
export const GetIdentityProviderHttp = Layer.effect(
  GetIdentityProvider,
  Effect.gen(function* () {
    const environment = yield* CloudflareEnvironment;

    return Effect.fn(function* (options: FindIdentityProviderOptions) {
      return Effect.fn("Cloudflare.Access.GetIdentityProvider")(function* () {
        const { accountId } = yield* environment;
        const match = yield* findFirst(
          options.zoneId,
          accountId,
          (idp) =>
            (options.name === undefined || idp.name === options.name) &&
            (options.type === undefined || idp.type === options.type),
        );
        return match
          ? toAttributes(match, options.zoneId, accountId, undefined)
          : undefined;
      });
    });
  }),
);
