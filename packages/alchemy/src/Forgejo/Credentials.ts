import {
  type Config,
  Credentials,
  credentials,
  normalizeBaseUrl,
} from "@distilled.cloud/forgejo";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type { AuthError, NeedsReauth } from "../Auth/AuthProvider.ts";
import { resolveProviderConfig } from "../Auth/Resolve.ts";
import { UserFacingError } from "../UserFacingError.ts";
import {
  FORGEJO_AUTH_PROVIDER_NAME,
  type ForgejoAuthConfig,
  type ForgejoResolvedCredentials,
} from "./AuthProvider.ts";

export {
  API_PATH,
  Credentials,
  CredentialsFromEnv,
  credentials,
  normalizeBaseUrl,
  type Config as CredentialsConfig,
} from "@distilled.cloud/forgejo";

/**
 * Configuration used to connect to a Forgejo instance.
 */
export interface ForgejoClientOptions {
  /**
   * Forgejo origin or API v1 base URL.
   */
  readonly baseUrl: string;
  /**
   * Forgejo access token.
   */
  readonly token: string | Redacted.Redacted<string>;
}

/**
 * The instance origin a resolved credential points at, without the API
 * prefix — what web URLs for the instance's pages are built from.
 *
 * Forgejo's organization representation carries no `html_url`, unlike its
 * repository representation, so links to an organization are derived from
 * the instance rather than read off the response.
 */
export const originOf = (config: Config): string =>
  config.apiBaseUrl.replace(/\/api\/v1$/, "");

/**
 * Build a credentials layer from a Forgejo URL and access token.
 */
export const fromToken = (
  options: ForgejoClientOptions,
): Layer.Layer<Credentials> => credentials(options);

/**
 * Raised when environment authentication is requested without the required
 * variables.
 */
export class MissingForgejoEnvironment extends Data.TaggedError(
  "MissingForgejoEnvironment",
)<{
  /**
   * Names of the environment variables that were not set.
   */
  readonly missing: readonly string[];
}> {
  /**
   * Human-readable description of the missing configuration.
   */
  override get message(): string {
    return `Set ${this.missing.join(" and ")} to use Forgejo providers.`;
  }
}

/**
 * Build a credentials layer from `FORGEJO_URL` and `FORGEJO_TOKEN`.
 */
export const fromEnv = () =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const baseUrl = yield* Effect.sync(() => process.env.FORGEJO_URL);
      const token = yield* Effect.sync(() => process.env.FORGEJO_TOKEN);
      const missing = [
        ...(baseUrl === undefined ? ["FORGEJO_URL"] : []),
        ...(token === undefined ? ["FORGEJO_TOKEN"] : []),
      ];
      if (baseUrl === undefined || token === undefined) {
        return yield* new MissingForgejoEnvironment({ missing });
      }
      return Effect.succeed<Config>({
        token: Redacted.make(token),
        apiBaseUrl: normalizeBaseUrl(baseUrl),
      });
    }),
  );

/**
 * Raised when neither the selected profile nor the CI environment yields a
 * usable Forgejo credential.
 */
export class UnresolvedForgejoCredentials extends Data.TaggedError(
  "UnresolvedForgejoCredentials",
)<{
  /**
   * Where resolution was attempted, e.g. `profile 'default'`.
   */
  readonly source: string;
  /**
   * Underlying auth-provider failure.
   */
  readonly cause: unknown;
}> {
  readonly [UserFacingError] = true;

  /**
   * Human-readable description of the failed resolution.
   */
  override get message(): string {
    return (
      `Failed to resolve Forgejo credentials from ${this.source}. ` +
      "Run `alchemy profile edit --add Forgejo`, or set FORGEJO_URL and " +
      "FORGEJO_TOKEN."
    );
  }
}

/**
 * Build a credentials layer from the selected alchemy profile, falling back
 * to `FORGEJO_URL` / `FORGEJO_TOKEN` in CI.
 *
 * This is what `providers()` uses when no explicit `{ baseUrl, token }` is
 * passed, so `alchemy profile edit --add Forgejo` is enough to authenticate
 * a stack.
 *
 * Maps onto `@distilled.cloud/forgejo`'s `{ token, apiBaseUrl }` shape.
 */
export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const { profileName, resolve } = yield* resolveProviderConfig<
        ForgejoAuthConfig,
        ForgejoResolvedCredentials
      >(FORGEJO_AUTH_PROVIDER_NAME);

      // `resolve` is a union of the environment-branch and profile-branch
      // effects, whose error channels differ. Widen it to their common
      // supertype: piping the union directly infers `unknown` requirements,
      // which silently poisons `StackServices` for every consumer.
      const resolved: Effect.Effect<
        ForgejoResolvedCredentials,
        AuthError | NeedsReauth
      > = resolve;

      return yield* resolved.pipe(
        Effect.map((creds): Config => ({
          token: creds.token,
          apiBaseUrl: normalizeBaseUrl(creds.baseUrl),
        })),
        Effect.mapError(
          (cause) =>
            new UnresolvedForgejoCredentials({
              source:
                profileName === undefined
                  ? "the CI environment"
                  : `profile '${profileName}'`,
              cause,
            }),
        ),
        Effect.orDie,
        Effect.cached,
      );
    }),
  );
