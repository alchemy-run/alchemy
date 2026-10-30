import { SuppressMissingProviderConfig } from "alchemy/Auth/Profile";
import { logLoadedKeys } from "alchemy/Secrets/Log";
import {
  resolveSecretsOption,
  type SecretsLayer,
  type SecretsOption,
} from "alchemy/Secrets/Provider";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { resolveCredentials } from "./AuthProvider.ts";
import { OnePasswordSecretsError } from "./Errors.ts";
import { loadSecrets } from "./internal/sdk.ts";
import { SecretReference } from "./SecretReference.ts";

interface OnePasswordAuthOptions {
  /**
   * Desktop account name (as displayed in the app sidebar) or UUID.
   * Defaults to the selected Alchemy profile. Ignored when OP_SERVICE_ACCOUNT_TOKEN
   * is set. Desktop authorization is unavailable in CI.
   */
  account?: string;
}

/** Load either an entire Environment or explicitly named vault references. */
export type OnePasswordOptions = OnePasswordAuthOptions &
  (
    | {
        /** The Environment ID copied from 1Password's Developer > View Environments. */
        environmentId: string;
        references?: never;
      }
    | {
        /** Map Effect config keys to op://vault/item/[section/]field references. */
        references: Readonly<Record<string, string>>;
        environmentId?: never;
      }
  );

const NonBlankString = Schema.String.check(Schema.makeFilter((value) => value.trim().length > 0));

/** Runtime validation for both static and stage-dependent Secrets options. */
export const OnePasswordOptionsSchema = Schema.Union([
  Schema.Struct({
    environmentId: NonBlankString,
    references: Schema.optional(Schema.Never),
    account: Schema.optional(NonBlankString),
  }),
  Schema.Struct({
    references: Schema.Record(Schema.String, SecretReference).check(
      Schema.makeFilter((value) => {
        const keys = Object.keys(value);
        return keys.length > 0 && keys.every((key) => key.trim().length > 0);
      }),
    ),
    environmentId: Schema.optional(Schema.Never),
    account: Schema.optional(NonBlankString),
  }),
]);

/** A stack secrets entry backed by a 1Password Environment or vault references. */
export class OnePasswordSecretsProvider extends Data.TaggedClass(
  "alchemy/SecretProvider::1Password",
)<{
  readonly layer: SecretsLayer;
}> {}

/**
 * Load a 1Password Environment or vault references into Effect Config without modifying process.env.
 * All values, including empty and unmasked values, are included. Consume secrets
 * with Config.Redacted. Later providers override earlier ones; the stack's
 * implicit process-environment provider retains its usual precedence.
 *
 * ### Selecting an Environment
 * **Example:** Different Environments for production and development
 * ```ts
 * import * as OnePassword from "@alchemy.run/1password";
 *
 * const secrets = [OnePassword.Secrets(({ stage }) => ({
 *   environmentId: stage === "prod" ? "production-id" : "development-id",
 * }))];
 * ```
 *
 * ### Resolving vault references
 * **Example:** Map config keys to item fields
 * ```ts
 * const secrets = [OnePassword.Secrets({
 *   references: {
 *     DATABASE_URL: "op://Production/Database/url",
 *     API_KEY: "op://Production/API/credentials/key",
 *   },
 * })];
 * ```
 * Choose exactly one of `environmentId` or `references` per entry. The exported
 * `SecretReference` schema validates URI syntax before authentication. Unique
 * references are resolved in one SDK `resolveAll` call per initialization;
 * any individual failure rejects the whole load without exposing partial values.
 * Environment values containing `op://` are literal, not recursively resolved.
 * OTP and SSH queries supported by the SDK are allowed; OTP values are snapshots
 * at initialization, not refreshed on each config read.
 *
 * ### Authorizing locally
 * **Example:** Use the 1Password desktop app
 * ```ts
 * const secrets = [OnePassword.Secrets({
 *   environmentId: "development-id",
 *   account: "My Account",
 * })];
 * ```
 * Enable SDK integration in the desktop app's Developer settings. You can also
 * configure an account with `alchemy profile edit --add 1Password`. In CI,
 * set OP_SERVICE_ACCOUNT_TOKEN with read access to the Environment.
 * Authentication never falls back after a rejected token.
 *
 * ### Rate limits <!-- api-prose -->
 * The Environment or reference batch is fetched once per layer initialization, not per config key.
 * Rate limits fail with OnePasswordRateLimitError without automatic retries.
 * Check `op service-account ratelimit`, wait for the quota window to reset, and
 * reduce concurrent CI jobs. No secrets are cached on disk or logged.
 *
 */
export const Secrets = (options: SecretsOption<OnePasswordOptions>) =>
  new OnePasswordSecretsProvider({
    layer: ConfigProvider.layerAdd(
      Effect.gen(function* () {
        if (yield* SuppressMissingProviderConfig) return ConfigProvider.fromEnv({ env: {} });
        const supplied = yield* resolveSecretsOption(options);
        const resolved = yield* Schema.decodeEffect(OnePasswordOptionsSchema)(supplied).pipe(
          // Schema issues retain their input; never expose malformed references or values.
          Effect.mapError(
            () =>
              new OnePasswordSecretsError({ operation: "initialize", reason: "InvalidOptions" }),
          ),
        );
        const credentials = yield* resolveCredentials(resolved.account);
        const env = yield* loadSecrets(resolved, credentials);
        yield* logLoadedKeys(
          resolved.environmentId === undefined
            ? "1Password (references)"
            : `1Password (Environment '${resolved.environmentId}')`,
          Object.keys(env),
        );
        return ConfigProvider.fromEnv({ env, preserveEmptyStrings: true });
      }),
      { asPrimary: true },
    ),
  });
