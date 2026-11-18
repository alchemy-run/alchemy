import { SuppressMissingProviderConfig } from "alchemy/Auth/Profile";
import { logLoadedKeys } from "alchemy/Secrets/Log";
import {
  resolveSecretsOption,
  type SecretsLayer,
  type SecretsOption,
  type SecretsServices,
} from "alchemy/Secrets/Provider";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { resolveCredentials } from "./AuthProvider.ts";
import { readItem, resolveReferences } from "./internal/cli.ts";

/** Options for {@link SecretReferences}: load chosen fields under config keys. */
export interface SecretReferencesOptions {
  /**
   * Map Effect config keys to `pass://vault/item/field` references. Vault and
   * item may be names or IDs; a field in a custom section is `Section.field`.
   */
  references: Readonly<Record<string, string>>;
}

/** Options for {@link Item}: load every text and hidden field of one item. */
export interface ItemOptions {
  /** The vault's name or share ID. */
  vault: string;
  /** The item's title or ID. */
  item: string;
}

/** A stack secrets entry backed by Proton Pass. */
export class ProtonPassSecretsProvider extends Data.TaggedClass(
  "alchemy/SecretProvider::ProtonPass",
)<{
  readonly layer: SecretsLayer;
}> {}

const provider = <E, R extends SecretsServices>(
  label: string,
  load: Effect.Effect<Record<string, string>, E, R>,
) =>
  new ProtonPassSecretsProvider({
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
 * Load chosen Proton Pass fields into Effect Config, each under the config key
 * you map it to, without modifying process.env. Consume secrets with
 * Config.Redacted. Later `secrets` entries override earlier ones, and the
 * shell stays on top unless listed or disabled.
 *
 * ### Resolving vault references
 * **Example:** Map config keys to item fields
 * ```ts
 * import * as ProtonPass from "@alchemy.run/proton-pass";
 *
 * const secrets = [
 *   ProtonPass.SecretReferences({
 *     references: {
 *       DATABASE_URL: "pass://Production/Database/password",
 *       API_KEY: "pass://Production/API/Staging.key",
 *     },
 *   }),
 * ];
 * ```
 * References use `pass://vault/item/field`, where vault and item are names or
 * IDs and a field inside a custom section is `Section.field`. Every reference
 * is read when the stack loads; if any fails, the stack fails naming its
 * config key and nothing is loaded.
 *
 * ### Choosing references per stage
 * **Example:** Different vaults for production and development
 * ```ts
 * const secrets = [
 *   ProtonPass.SecretReferences(({ stage }) => ({
 *     references: {
 *       DATABASE_URL: `pass://${stage === "prod" ? "Production" : "Development"}/Database/password`,
 *     },
 *   })),
 * ];
 * ```
 *
 * ### Authorizing locally
 * **Example:** Use the Proton Pass CLI's login
 * ```sh
 * pass-cli login
 * ```
 * With no profile entry and no token, Alchemy reads through the session of the
 * installed `pass-cli`. You can also store a token in the profile with
 * `alchemy profile edit --add ProtonPass --method personal-access-token --set token=-`.
 *
 * ### Authorizing in CI
 * **Example:** A personal access token
 * ```sh
 * pass-cli personal-access-token create --name ci --expiration 3m
 * pass-cli personal-access-token access grant --personal-access-token-name ci --vault-name Production --role viewer
 * ```
 * Set the token as PROTON_PASS_PERSONAL_ACCESS_TOKEN. It wins over the profile
 * and the CLI's login, and logs in to a temporary session that is logged out
 * after loading, so the CLI's own session is never touched.
 */
export const SecretReferences = (options: SecretsOption<SecretReferencesOptions>) =>
  provider(
    "Proton Pass (secret references)",
    Effect.gen(function* () {
      const { references } = yield* resolveSecretsOption(options);
      const credentials = yield* resolveCredentials;
      return yield* resolveReferences(references, credentials);
    }),
  );

/**
 * Load every text and hidden field of one Proton Pass item into Effect Config,
 * under the field's own name, without modifying process.env. Keep a custom
 * item per environment with one field per variable. Empty values are kept;
 * TOTP and timestamp fields are skipped. Two fields with the same name, even in
 * different sections, fail the load.
 *
 * ### Loading an item
 * **Example:** One item per stage
 * ```ts
 * import * as ProtonPass from "@alchemy.run/proton-pass";
 *
 * const secrets = [
 *   ProtonPass.Item(({ stage }) => ({
 *     vault: "Alchemy",
 *     item: stage === "prod" ? "app-production" : "app-development",
 *   })),
 * ];
 * ```
 *
 * **Example:** An item plus individual fields
 * ```ts
 * const secrets = [
 *   ProtonPass.Item({ vault: "Alchemy", item: "app-production" }),
 *   ProtonPass.SecretReferences({
 *     references: { STRIPE_KEY: "pass://Billing/Stripe/password" },
 *   }),
 * ];
 * ```
 * Values containing `pass://` are literal, not resolved. Authorization works as
 * for {@link SecretReferences}.
 */
export const Item = (options: SecretsOption<ItemOptions>) =>
  provider(
    "Proton Pass (item)",
    Effect.gen(function* () {
      const { vault, item } = yield* resolveSecretsOption(options);
      const credentials = yield* resolveCredentials;
      return yield* readItem({ vault, item }, credentials);
    }),
  );
