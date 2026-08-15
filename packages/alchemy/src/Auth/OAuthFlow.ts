import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import crypto from "node:crypto";
import http from "node:http";
import { AUTH_ERROR_URL, AUTH_SUCCESS_URL } from "./AuthProvider.ts";

export class OAuthError extends Data.TaggedError("OAuthError")<{
  error: string;
  errorDescription: string;
}> {}

/**
 * On-disk shape of OAuth credentials persisted under
 * `~/.alchemy/credentials/{profile}/<provider>-oauth.json`.
 *
 * `clientId` is optional because files written before the client id was
 * recorded must still parse — {@link OAuthClient.usesCurrentClient} treats a
 * missing id as "issued to a previous client", which triggers a clean
 * re-login.
 */
export const OAuthCredentials = Schema.Struct({
  type: Schema.Literal("oauth"),
  clientId: Schema.optional(Schema.String),
  access: Schema.String,
  refresh: Schema.String,
  expires: Schema.Number,
  scopes: Schema.mutable(Schema.Array(Schema.String)),
});
export type OAuthCredentials = typeof OAuthCredentials.Type;

export interface Authorization {
  url: string;
  state: string;
  /** PKCE verifier; present only for `auth: { kind: "pkce" }` clients. */
  verifier?: string;
}

/**
 * The provider-specific facts a browser OAuth flow needs. Everything else —
 * state/PKCE generation, the loopback callback server, hosted-relay code
 * extraction, token exchange, refresh, revoke — is shared.
 */
export interface OAuthClientSpec {
  readonly clientId: string;
  readonly endpoints: {
    readonly authorize: string;
    readonly token: string;
    /** Providers without a revocation endpoint omit it; `revoke` then no-ops. */
    readonly revoke?: string;
  };
  /** Hosted relay redirect URI registered with the OAuth application. */
  readonly redirectUri: string;
  /** Loopback URI the local callback server listens on. */
  readonly localCallbackUri: string;
  /**
   * Client authentication. `pkce` for public clients; `clientSecret` for
   * providers whose token endpoint requires client authentication for every
   * grant (the secret ships in the CLI — same exposure posture as a public
   * client id, rotated by cutting a release).
   */
  readonly auth:
    | { readonly kind: "pkce" }
    | { readonly kind: "clientSecret"; readonly clientSecret: string };
  /**
   * How token-request parameters travel: URL-encoded POST body (the OAuth 2
   * standard, default) or the query string (PlanetScale's documented form).
   */
  readonly tokenTransport?: "body" | "query";
}

export interface OAuthClient {
  readonly clientId: string;
  /** Whether persisted credentials were issued to this client. */
  readonly usesCurrentClient: (credentials: {
    readonly clientId?: unknown;
  }) => boolean;
  /**
   * Generate an authorization URL. Pass `scopes` only for providers that
   * take them per-authorization; omit for providers whose scopes are
   * configured on the application.
   */
  readonly authorize: (scopes?: ReadonlyArray<string>) => Authorization;
  /**
   * Exchange an authorization code directly. `authorization` supplies the
   * PKCE verifier; omit for non-PKCE clients (tests, relay-less flows).
   */
  readonly exchange: (
    code: string,
    authorization?: Authorization,
  ) => Effect.Effect<OAuthCredentials, OAuthError>;
  /**
   * Exchange a code copied from the hosted relay page, or extract the code
   * from either the hosted or loopback callback URL.
   */
  readonly exchangeCallbackInput: (
    input: string,
    authorization: Authorization,
  ) => Effect.Effect<OAuthCredentials, OAuthError>;
  /**
   * Start a local HTTP server to listen for the OAuth callback, exchange
   * the authorization code, and return the credentials. Times out after 5
   * minutes.
   */
  readonly callback: (
    authorization: Authorization,
  ) => Effect.Effect<OAuthCredentials, OAuthError>;
  /** Refresh expired OAuth credentials with the stored refresh token. */
  readonly refresh: (
    credentials: OAuthCredentials,
  ) => Effect.Effect<OAuthCredentials, OAuthError>;
  /** Revoke the refresh token; no-op when the spec has no revoke endpoint. */
  readonly revoke: (
    credentials: OAuthCredentials,
  ) => Effect.Effect<void, OAuthError>;
}

const generateState = (length = 32): string =>
  crypto.randomBytes(length).toString("base64url");

const generatePKCE = (
  length = 96,
): {
  verifier: string;
  challenge: string;
} => {
  const verifier = crypto.randomBytes(length).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return { verifier, challenge };
};

export const makeOAuthClient = (spec: OAuthClientSpec): OAuthClient => {
  const clientAuthParams = (): Record<string, string> =>
    spec.auth.kind === "clientSecret"
      ? { client_secret: spec.auth.clientSecret }
      : {};

  const extractCredentials = (
    json: {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      scope?: string;
    },
    previous?: OAuthCredentials,
  ): Effect.Effect<OAuthCredentials, OAuthError> => {
    const refresh = json.refresh_token ?? previous?.refresh;
    if (!refresh) {
      return Effect.fail(
        new OAuthError({
          error: "invalid_token_response",
          errorDescription:
            "The provider did not return a refresh token for this authorization.",
        }),
      );
    }
    return Effect.succeed({
      type: "oauth" as const,
      clientId: spec.clientId,
      access: json.access_token,
      refresh,
      expires: Date.now() + json.expires_in * 1000,
      scopes: json.scope?.split(" ") ?? previous?.scopes ?? [],
    });
  };

  const tokenRequest = (
    params: Record<string, string>,
    previous?: OAuthCredentials,
  ): Effect.Effect<OAuthCredentials, OAuthError> =>
    Effect.gen(function* () {
      const transport = spec.tokenTransport ?? "body";
      const url = new URL(spec.endpoints.token);
      const init: RequestInit = {
        method: "POST",
        headers: { Accept: "application/json" },
      };
      if (transport === "query") {
        for (const [k, v] of Object.entries(params)) {
          url.searchParams.set(k, v);
        }
      } else {
        init.headers = {
          ...init.headers,
          "Content-Type": "application/x-www-form-urlencoded",
        };
        init.body = new URLSearchParams(params).toString();
      }

      const res = yield* Effect.tryPromise({
        try: () => fetch(url.toString(), init),
        catch: (err) =>
          new OAuthError({
            error: "network_error",
            errorDescription: `Token request failed: ${err}`,
          }),
      });

      if (!res.ok) {
        const json = yield* Effect.tryPromise({
          try: () =>
            res.json() as Promise<{ error: string; error_description: string }>,
          catch: () =>
            new OAuthError({
              error: "parse_error",
              errorDescription: `Token endpoint returned ${res.status}`,
            }),
        });
        return yield* new OAuthError({
          error: json.error,
          errorDescription: json.error_description,
        });
      }

      const json = yield* Effect.tryPromise({
        try: () =>
          res.json() as Promise<{
            access_token: string;
            refresh_token?: string;
            expires_in: number;
            scope?: string;
          }>,
        catch: () =>
          new OAuthError({
            error: "parse_error",
            errorDescription: "Failed to parse token response",
          }),
      });
      return yield* extractCredentials(json, previous);
    });

  const authorize = (scopes?: ReadonlyArray<string>): Authorization => {
    const state = generateState();
    const url = new URL(spec.endpoints.authorize);
    url.searchParams.set("client_id", spec.clientId);
    url.searchParams.set("redirect_uri", spec.redirectUri);
    url.searchParams.set("response_type", "code");
    if (scopes !== undefined) {
      url.searchParams.set("scope", scopes.join(" "));
    }
    url.searchParams.set("state", state);
    if (spec.auth.kind === "pkce") {
      const pkce = generatePKCE();
      url.searchParams.set("code_challenge", pkce.challenge);
      url.searchParams.set("code_challenge_method", "S256");
      return { url: url.toString(), state, verifier: pkce.verifier };
    }
    return { url: url.toString(), state };
  };

  const exchange = (
    code: string,
    authorization?: Authorization,
  ): Effect.Effect<OAuthCredentials, OAuthError> =>
    tokenRequest({
      grant_type: "authorization_code",
      code,
      client_id: spec.clientId,
      redirect_uri: spec.redirectUri,
      ...clientAuthParams(),
      ...(authorization?.verifier === undefined
        ? {}
        : { code_verifier: authorization.verifier }),
    });

  const refresh = (
    credentials: OAuthCredentials,
  ): Effect.Effect<OAuthCredentials, OAuthError> =>
    tokenRequest(
      {
        grant_type: "refresh_token",
        refresh_token: credentials.refresh,
        client_id: spec.clientId,
        ...clientAuthParams(),
      },
      credentials,
    );

  const revoke = (
    credentials: OAuthCredentials,
  ): Effect.Effect<void, OAuthError> => {
    const endpoint = spec.endpoints.revoke;
    if (endpoint === undefined) return Effect.void;
    return Effect.tryPromise({
      try: () =>
        fetch(endpoint, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            token: credentials.refresh,
            token_type_hint: "refresh_token",
            client_id: spec.clientId,
            ...clientAuthParams(),
          }).toString(),
        }),
      catch: (err) =>
        new OAuthError({
          error: "network_error",
          errorDescription: `Revoke request failed: ${err}`,
        }),
    }).pipe(Effect.asVoid);
  };

  const exchangeCallbackInput = (
    input: string,
    authorization: Authorization,
  ): Effect.Effect<OAuthCredentials, OAuthError> =>
    Effect.gen(function* () {
      const value = input.trim();
      let code = value;
      let state: string | null = null;

      try {
        const url = new URL(value);
        code = url.searchParams.get("code") ?? "";
        state = url.searchParams.get("state");
      } catch {
        const separator = value.lastIndexOf("#");
        if (separator >= 0) {
          code = value.slice(0, separator);
          state = value.slice(separator + 1);
        }
      }

      if (!code) {
        return yield* new OAuthError({
          error: "invalid_request",
          errorDescription: "The authorization code is missing.",
        });
      }
      if (state !== null && state !== authorization.state) {
        return yield* new OAuthError({
          error: "invalid_request",
          errorDescription: "The authorization state does not match.",
        });
      }
      return yield* exchange(code, authorization);
    });

  const callbackPromise = (
    authorization: Authorization,
    signal: AbortSignal,
  ): Promise<OAuthCredentials> => {
    const { pathname, port } = new URL(spec.localCallbackUri);

    return new Promise<OAuthCredentials>((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

        if (url.pathname === "/auth/ping") {
          res.writeHead(req.method === "OPTIONS" ? 204 : 200, {
            "Access-Control-Allow-Origin": new URL(spec.redirectUri).origin,
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Access-Control-Allow-Private-Network": "true",
            "Cache-Control": "no-store",
          });
          res.end();
          return;
        }

        if (url.pathname !== pathname) {
          res.statusCode = 404;
          res.end("Not Found");
          return;
        }

        const error = url.searchParams.get("error");
        const errorDescription = url.searchParams.get("error_description");
        if (error) {
          res.writeHead(302, { Location: AUTH_ERROR_URL });
          res.end();
          cleanup();
          reject(
            new OAuthError({
              error,
              errorDescription:
                errorDescription ?? "An unknown error occurred.",
            }),
          );
          return;
        }

        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (!code || !state) {
          res.writeHead(302, { Location: AUTH_ERROR_URL });
          res.end();
          cleanup();
          reject(
            new OAuthError({
              error: "invalid_request",
              errorDescription: "Missing code or state",
            }),
          );
          return;
        }

        if (state !== authorization.state) {
          res.writeHead(302, { Location: AUTH_ERROR_URL });
          res.end();
          cleanup();
          reject(
            new OAuthError({
              error: "invalid_request",
              errorDescription: "Invalid state",
            }),
          );
          return;
        }

        try {
          const credentials = await Effect.runPromise(
            exchange(code, authorization),
          );
          res.writeHead(302, { Location: AUTH_SUCCESS_URL });
          res.end();
          cleanup();
          resolve(credentials);
        } catch (err) {
          res.writeHead(302, { Location: AUTH_ERROR_URL });
          res.end();
          cleanup();
          reject(err);
        }
      });

      const timeout = setTimeout(
        () => {
          cleanup();
          reject(
            new OAuthError({
              error: "timeout",
              errorDescription: "The authorization process timed out.",
            }),
          );
        },
        5 * 60 * 1000,
      );

      function cleanup() {
        clearTimeout(timeout);
        signal.removeEventListener("abort", cleanup);
        server.close();
      }

      signal.addEventListener("abort", cleanup, { once: true });

      server.on("error", (err) => {
        cleanup();
        reject(
          new OAuthError({
            error: "server_error",
            errorDescription: `Failed to start callback server: ${err.message}`,
          }),
        );
      });

      server.listen(Number(port));
    });
  };

  const callback = (
    authorization: Authorization,
  ): Effect.Effect<OAuthCredentials, OAuthError> =>
    Effect.tryPromise({
      try: (signal) => callbackPromise(authorization, signal),
      catch: (err) => {
        if (err instanceof OAuthError) return err;
        return new OAuthError({
          error: "callback_error",
          errorDescription: `OAuth callback failed: ${err}`,
        });
      },
    });

  return {
    clientId: spec.clientId,
    usesCurrentClient: (credentials) => credentials.clientId === spec.clientId,
    authorize,
    exchange,
    exchangeCallbackInput,
    callback,
    refresh,
    revoke,
  };
};
