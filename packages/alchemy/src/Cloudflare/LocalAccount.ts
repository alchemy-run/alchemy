import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ProfileStore } from "../Auth/Profile.ts";
import {
  CLOUDFLARE_AUTH_PROVIDER_NAME,
  CloudflareAuthConfigSchema,
} from "./Auth/AuthConfig.ts";

/** Fallback identity when local dev has no configured Cloudflare account. */
export const LOCAL_ACCOUNT_ID = "00000000000000000000000000000000";

// Read identity only: expired OAuth credentials must not prevent local dev,
// and discovering an account must never authenticate or refresh a token.
export const localAccountId = Effect.gen(function* () {
  const accountId = yield* Config.option(
    Config.String("CLOUDFLARE_ACCOUNT_ID"),
  );
  if (Option.isSome(accountId) && accountId.value.trim()) {
    return accountId.value.trim();
  }
  if (yield* Config.Boolean("CI").pipe(Config.withDefault(false))) {
    return LOCAL_ACCOUNT_ID;
  }
  const store = yield* Effect.serviceOption(ProfileStore);
  if (Option.isNone(store)) return LOCAL_ACCOUNT_ID;
  const profiles = store.value;
  const { name } = yield* profiles.current;
  const profile = yield* profiles.getProfile(name);
  const stored = profile?.providers[CLOUDFLARE_AUTH_PROVIDER_NAME];
  if (stored === undefined) return LOCAL_ACCOUNT_ID;
  const config = yield* Schema.decodeUnknownEffect(CloudflareAuthConfigSchema)(
    stored,
  );
  return "accountId" in config ? config.accountId : LOCAL_ACCOUNT_ID;
}).pipe(Effect.orDie);
