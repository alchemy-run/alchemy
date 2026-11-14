import { Credentials } from "@distilled.cloud/aws/Credentials";
import * as secretsmanager from "@distilled.cloud/aws/secrets-manager";
import { refreshHint } from "alchemy/Auth/AuthProvider";
import { SuppressMissingProviderConfig } from "alchemy/Auth/Profile";
import { resolveProviderConfig } from "alchemy/Auth/Resolve";
import { logLoadedKeys } from "alchemy/Secrets/Log";
import {
  CredentialsConfig,
  resolveSecretsOption,
  type SecretsLayer,
  type SecretsOption,
} from "alchemy/Secrets/Provider";
import { UserFacingError } from "alchemy/UserFacingError";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import {
  AWS_AUTH_PROVIDER_NAME,
  AwsAuth,
  type AwsAuthConfig,
  type AwsResolvedCredentials,
} from "./AuthProvider.ts";
import * as Endpoint from "./Endpoint.ts";
import * as Region from "./Region.ts";

export interface AwsSecretsOptions {
  /**
   * Name prefix of the secrets to load, e.g. `"my-app/prod/"`. A secret
   * named `my-app/prod/API_KEY` becomes the config key `API_KEY`. Names with
   * a further `/` after the prefix are nested and skipped.
   */
  prefix: string;
}

/** A per-secret failure Secrets Manager reported in `BatchGetSecretValue`'s `Errors`. */
export interface AwsSecretsFailure {
  readonly secretId: string;
  readonly errorCode: string | undefined;
  readonly message: string | undefined;
}

/**
 * Secrets Manager could not serve the requested secrets. The message says
 * "AWS Secrets Manager" up front and names the prefix, so a stack trace never
 * has to be read to know which secrets source broke.
 */
export class AwsSecretsError extends Data.TaggedError("AwsSecretsError")<{
  readonly prefix: string;
  /** Set when the credentials came from a stored Alchemy profile. */
  readonly profileName: string | undefined;
  /** Secrets the request listed in `Errors`, e.g. ones the login may not read. */
  readonly failures: ReadonlyArray<AwsSecretsFailure>;
  /** What the request failed with, when it failed as a whole. */
  readonly cause?: { readonly _tag: string; readonly message?: string };
}> {
  readonly [UserFacingError] = true;

  override get message() {
    const selection = `prefix '${this.prefix}'`;
    if (this.failures.length > 0) {
      const names = this.failures
        .map(
          (failure) =>
            `${failure.secretId} (${[failure.errorCode, failure.message].filter(Boolean).join(": ") || "unknown error"})`,
        )
        .join(", ");
      return `AWS Secrets Manager could not read ${this.failures.length} secrets under ${selection}: ${names}. The AWS login needs secretsmanager:GetSecretValue on each of them.`;
    }
    const detail = this.cause?.message ?? this.cause?._tag ?? "unknown error";
    if (this.cause?._tag === "AccessDeniedException") {
      const login =
        this.profileName === undefined
          ? "Check the AWS credentials in the environment."
          : refreshHint(AWS_AUTH_PROVIDER_NAME, this.profileName);
      return `AWS Secrets Manager denied loading ${selection}: ${detail}. The AWS login needs secretsmanager:BatchGetSecretValue and secretsmanager:ListSecrets. ${login}`;
    }
    return `AWS Secrets Manager could not load secrets under ${selection}: ${detail}`;
  }
}

/**
 * Resolve the stack's AWS login through the AWS auth provider: environment
 * credentials when present (and always in CI), otherwise the selected
 * profile. The same login and region the stack's AWS resources use.
 */
const resolveCredentials = Effect.gen(function* () {
  const resolved = yield* resolveProviderConfig<AwsAuthConfig, AwsResolvedCredentials>(
    AWS_AUTH_PROVIDER_NAME,
  ).pipe(Effect.provide(AwsAuth));
  const credentials = yield* resolved.resolve;
  return { credentials, profileName: resolved.profileName };
}).pipe(Effect.provide(CredentialsConfig));

const text = (value: string | Redacted.Redacted<string>) =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

/**
 * Read every secret whose name starts with `prefix` as a flat env map.
 * `BatchGetSecretValue`'s `name` filter is a case-sensitive prefix match; the
 * names are checked against the prefix again before any is loaded.
 */
const downloadSecrets = Effect.fn("downloadAwsSecrets")(function* (
  options: AwsSecretsOptions,
  { credentials, profileName }: Effect.Success<typeof resolveCredentials>,
) {
  const pages = yield* secretsmanager.batchGetSecretValue
    .pages({
      Filters: [{ Key: "name", Values: [options.prefix] }],
      MaxResults: 20,
    })
    .pipe(
      Stream.runCollect,
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(Credentials, credentials.credentials),
          Region.of(credentials.region),
          credentials.endpoint === undefined ? Endpoint.none : Endpoint.of(credentials.endpoint),
        ),
      ),
      Effect.timeout("30 seconds"),
      Effect.mapError(
        (cause) =>
          new AwsSecretsError({
            prefix: options.prefix,
            profileName,
            failures: [],
            cause,
          }),
      ),
    );

  // `BatchGetSecretValue` answers 200 and lists a secret it could not read
  // (access denied, decryption failed) in `Errors`. Fail rather than load the
  // rest, so a secret never falls back silently to an earlier source.
  const failures = pages.flatMap((page) =>
    (page.Errors ?? []).map((error): AwsSecretsFailure => ({
      secretId: error.SecretId ?? "unknown secret",
      errorCode: error.ErrorCode,
      message: error.Message,
    })),
  );
  if (failures.length > 0) {
    return yield* new AwsSecretsError({ prefix: options.prefix, profileName, failures });
  }

  const env: Record<string, string> = Object.create(null);
  for (const page of pages) {
    for (const secret of page.SecretValues ?? []) {
      if (secret.Name === undefined || !secret.Name.startsWith(options.prefix)) continue;
      const key = secret.Name.slice(options.prefix.length);
      // Nested names map to no key, as Infisical skips sub-folders.
      if (key === "" || key.includes("/")) continue;
      // A secret stored only as `SecretBinary` has no string value to load.
      if (secret.SecretString === undefined) continue;
      env[key] = text(secret.SecretString);
    }
  }
  return env;
});

/** A `secrets` entry that loads AWS Secrets Manager secrets under a name prefix. */
export class AwsSecretsProvider extends Data.TaggedClass("alchemy/SecretProvider::AWS")<{
  readonly layer: SecretsLayer;
}> {}

/**
 * Load AWS Secrets Manager secrets into Effect Config without touching
 * `process.env`. Every secret whose name starts with `prefix` becomes a key:
 * the rest of its name. Nested names (a `/` after the prefix) and secrets
 * stored only as `SecretBinary` are skipped.
 *
 * Reads with the stack's own AWS login and region, so it needs no credential
 * of its own: `alchemy profile edit --add AWS` locally, the AWS environment
 * variables in CI. The login needs `secretsmanager:BatchGetSecretValue`,
 * `secretsmanager:ListSecrets`, and `secretsmanager:GetSecretValue` on each
 * secret. A secret it may not read fails the load and is named.
 *
 * ```ts
 * secrets: [
 *   AWS.Secrets(({ stage }) => ({
 *     prefix: stage === "prod" ? "my-app/prod/" : "my-app/dev/",
 *   })),
 * ]
 * ```
 */
export const Secrets = (options: SecretsOption<AwsSecretsOptions>) =>
  new AwsSecretsProvider({
    layer: ConfigProvider.layerAdd(
      Effect.gen(function* () {
        // Auth-provider discovery builds stack layers just to find out which
        // providers are used. It must work offline and with broken
        // credentials, so the user can configure the very login this layer
        // needs.
        if (yield* SuppressMissingProviderConfig) return ConfigProvider.fromEnv({ env: {} });

        const resolved = yield* resolveSecretsOption(options);
        const credentials = yield* resolveCredentials;
        const env = yield* downloadSecrets(resolved, credentials);
        yield* logLoadedKeys(`AWS Secrets Manager (prefix '${resolved.prefix}')`, Object.keys(env));
        return ConfigProvider.fromEnv({ env, preserveEmptyStrings: true });
      }),
      { asPrimary: true },
    ),
  });
