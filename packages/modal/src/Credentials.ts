import { ConfigError } from "@distilled.cloud/core/errors";
import { withAuthToken } from "@distilled.cloud/modal/AuthToken";
import { Credentials, DEFAULT_API_BASE_URL } from "@distilled.cloud/modal/Credentials";
import { lazyCredentials } from "alchemy/Auth/Resolve";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { MODAL_AUTH_PROVIDER_NAME, type ModalResolvedCredentials } from "./AuthProvider.ts";
import { ModalTransport } from "./internal/Transport.ts";

export { withAuthToken } from "@distilled.cloud/modal/AuthToken";
export {
  Credentials,
  CredentialsFromEnv,
  DEFAULT_API_BASE_URL,
} from "@distilled.cloud/modal/Credentials";

/**
 * Build Modal `Credentials` that resolve through the Alchemy AuthProvider:
 * `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` when set, otherwise the selected
 * profile. Resolution is deferred until the first API call, so building the
 * provider layers never needs a profile.
 */
export const fromAuthProvider = () =>
  withAuthTokens(
    Layer.effect(
      Credentials,
      lazyCredentials<ModalResolvedCredentials, ConfigError>()(
        MODAL_AUTH_PROVIDER_NAME,
        (creds) => ({
          tokenId: creds.tokenId,
          tokenSecret: creds.tokenSecret,
          apiBaseUrl: creds.apiBaseUrl,
        }),
      ),
    ),
  );

/**
 * Add Modal's short-lived auth token (the `x-modal-auth-token` JWT its V2
 * sandbox RPCs and input plane need) to a token pair's `Credentials`.
 */
export const withAuthTokens = <E, R>(
  credentials: Layer.Layer<Credentials, E, R>,
): Layer.Layer<Credentials, E, R> =>
  withAuthToken.pipe(Layer.provide(Layer.mergeAll(credentials, ModalTransport)));

/**
 * Build Modal `Credentials` from an explicit token pair, e.g. in a test or a
 * script that already holds one.
 *
 * @example
 * ```ts
 * Effect.provide(Modal.fromToken({ tokenId: "ak-…", tokenSecret: "as-…" }))
 * ```
 */
export const fromToken = (input: {
  tokenId: string | Redacted.Redacted<string>;
  tokenSecret: string | Redacted.Redacted<string>;
  apiBaseUrl?: string;
}): Layer.Layer<Credentials> =>
  withAuthTokens(
    Layer.succeed(
      Credentials,
      Effect.succeed({
        tokenId: typeof input.tokenId === "string" ? Redacted.make(input.tokenId) : input.tokenId,
        tokenSecret:
          typeof input.tokenSecret === "string"
            ? Redacted.make(input.tokenSecret)
            : input.tokenSecret,
        apiBaseUrl: input.apiBaseUrl ?? DEFAULT_API_BASE_URL,
      }),
    ),
  );
