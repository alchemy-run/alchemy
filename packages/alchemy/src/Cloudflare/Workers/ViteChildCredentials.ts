import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { CloudflareAuth } from "../Auth/AuthProvider.ts";
import * as Credentials from "../Credentials.ts";

// Tooling credentials travel in the private child configuration, never in the
// Worker's bindings or the process environment inherited by application code.
const keys = [
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_API_KEY",
  "CLOUDFLARE_EMAIL",
  "CLOUDFLARE_ACCOUNT_EMAIL",
  "ALCHEMY_PROFILE",
  "CI",
] as const;

export const readCredentialConfig = Effect.gen(function* () {
  const values: Record<string, string> = {};
  for (const key of keys) {
    const value = yield* Config.option(Config.redacted(key));
    if (Option.isSome(value)) values[key] = Redacted.value(value.value);
  }
  return Redacted.make(values);
});

export const credentialsLayer = (config: Record<string, string>) =>
  Credentials.fromAuthProvider().pipe(
    Layer.provide(CloudflareAuth),
    // This is the parent's complete auth configuration, including absent keys.
    // Falling back to child env/dotenv could resurrect removed credentials.
    // Profile-backed OAuth still resolves and refreshes through the auth store.
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config))),
  );
