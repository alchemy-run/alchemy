import { SuppressMissingProviderConfig } from "alchemy/Auth/Profile";
import { logLoadedKeys } from "alchemy/Secrets/Log";
import {
  resolveSecretsOption,
  type SecretsLayer,
  type SecretsServices,
  type SecretsOption,
} from "alchemy/Secrets/Provider";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { resolveCredentials } from "./AuthProvider.ts";
import { loadSecrets } from "./internal/sdk.ts";

interface OnePasswordAuthOptions {
  /**
   * Desktop account: the name in the app's account switcher (e.g. `Family`,
   * not your own name; case-sensitive), the sign-in address without
   * `https://` (`my.1password.com`), or the account UUID.
   * Defaults to the selected Alchemy profile, which may hold a desktop selector
   * or a service account token. Ignored when OP_SERVICE_ACCOUNT_TOKEN is set.
   * Desktop authorization is unavailable in CI.
   */
  account?: string;
}

/** Options for {@link Environment}: load every variable of one 1Password Environment. */
export interface EnvironmentOptions extends OnePasswordAuthOptions {
  /** The Environment ID copied from 1Password's Developer > View Environments. */
  environmentId: string;
}

/** Options for {@link SecretReferences}: load chosen vault fields under config keys. */
export interface SecretReferencesOptions extends OnePasswordAuthOptions {
  /** Map Effect config keys to op://vault/item/[section/]field references. */
  references: Readonly<Record<string, string>>;
}

/** A stack secrets entry backed by a 1Password Environment or vault references. */
export class OnePasswordSecretsProvider extends Data.TaggedClass(
  "alchemy/SecretProvider::1Password",
)<{
  readonly layer: SecretsLayer;
}> {}

const provider = <E, R extends SecretsServices>(
  label: string,
  load: Effect.Effect<Record<string, string>, E, R>,
) =>
  new OnePasswordSecretsProvider({
    layer: ConfigProvider.layerAdd(
      Effect.gen(function* () {
        if (yield* SuppressMissingProviderConfig) return ConfigProvider.fromEnv({ env: {} });
        const env = yield* load;
        yield* logLoadedKeys(label, Object.keys(env));
        return ConfigProvider.fromEnv({ env, preserveEmptyStrings: true });
      }),
      { asPrimary: true },
    ),
  });

/**
 * Load every variable of a 1Password Environment into Effect Config, under its
 * own name, without modifying process.env. Empty values are kept. Consume
 * secrets with Config.Redacted. Later `secrets` entries override earlier ones,
 * and the shell stays on top unless listed or disabled.
 *
 * ### Selecting an Environment
 * **Example:** Different Environments for production and development
 * ```ts
 * import * as OnePassword from "@alchemy.run/1password";
 *
 * const secrets = [
 *   OnePassword.Environment(({ stage }) => ({
 *     environmentId: stage === "prod" ? "production-id" : "development-id",
 *   })),
 * ];
 * ```
 *
 * **Example:** An Environment plus individual vault fields
 * ```ts
 * const secrets = [
 *   OnePassword.Environment({ environmentId: "production-id" }),
 *   OnePassword.SecretReferences({
 *     references: { STRIPE_KEY: "op://Billing/Stripe/credential" },
 *   }),
 * ];
 * ```
 * Values containing `op://` are literal, not resolved.
 *
 * ### Authorizing locally
 * **Example:** Use the 1Password desktop app
 * ```ts
 * const secrets = [
 *   OnePassword.Environment({ environmentId: "development-id", account: "Family" }),
 * ];
 * ```
 * Enable "Integrate with other apps" in the desktop app's Developer settings.
 * The app asks you to authorize Alchemy once per run. You can also store the
 * account with `alchemy profile edit --add 1Password`. In CI, set
 * OP_SERVICE_ACCOUNT_TOKEN with read access to the Environment; it wins over
 * `account` and the profile, and a rejected token never falls back to the app.
 *
 * ### Storing a service account token
 * **Example:** Profile without the desktop app
 * ```sh
 * alchemy profile edit --add 1Password --method service-account --set token=-
 * ```
 *
 * ### Rate limits <!-- api-prose -->
 * The Environment is fetched once per stack load, not per config key. Rate
 * limits fail with OnePasswordRateLimitError and are not retried; check
 * `op service-account ratelimit` and wait for the quota to reset.
 */
export const Environment = (options: SecretsOption<EnvironmentOptions>) =>
  provider(
    "1Password (Environment)",
    Effect.gen(function* () {
      const { environmentId, account } = yield* resolveSecretsOption(options);
      const credentials = yield* resolveCredentials(account);
      return yield* loadSecrets({ environmentId }, credentials);
    }),
  );

/**
 * Load chosen 1Password vault fields into Effect Config, each under the config
 * key you map it to, without modifying process.env. Consume secrets with
 * Config.Redacted.
 *
 * ### Resolving vault references
 * **Example:** Map config keys to item fields
 * ```ts
 * import * as OnePassword from "@alchemy.run/1password";
 *
 * const secrets = [
 *   OnePassword.SecretReferences({
 *     references: {
 *       DATABASE_URL: "op://Production/Database/url",
 *       API_KEY: "op://Production/API/credentials/key",
 *     },
 *   }),
 * ];
 * ```
 * References use `op://vault/item/[section/]field`, optionally with
 * `?attribute=otp` (or `totp`) or `?ssh-format=openssh`. References are not
 * checked ahead of time: 1Password resolves them all in one batch at load, and
 * if any fails, the stack fails naming its config key and nothing is loaded.
 * OTP values are read once per stack load.
 *
 * Authorization works as for {@link Environment}: `OP_SERVICE_ACCOUNT_TOKEN`,
 * then `account`, then the selected profile. Rate limits fail with
 * OnePasswordRateLimitError and are not retried, as for {@link Environment}.
 */
export const SecretReferences = (options: SecretsOption<SecretReferencesOptions>) =>
  provider(
    "1Password (secret references)",
    Effect.gen(function* () {
      const { references, account } = yield* resolveSecretsOption(options);
      const credentials = yield* resolveCredentials(account);
      return yield* loadSecrets({ references }, credentials);
    }),
  );
