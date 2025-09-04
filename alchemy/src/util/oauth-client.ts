import crypto from "node:crypto";
import type { Credentials } from "../auth.ts";
import { DeferredPromise } from "./deferred-promise.ts";
import { HTTPServer } from "./http.ts";

export class OAuthError extends Error {
  readonly error: string;
  constructor({ error, error_description, ...rest }: OAuthErrorResponse) {
    super(error_description);
    this.error = error;
    this.name = "OAuthError";
    Object.assign(this, rest);
  }
}

export class OAuthClient {
  constructor(
    private readonly options: {
      clientId: string;
      redirectUri: string;
      endpoints: {
        authorize: string;
        token: string;
        revoke: string;
      };
    },
  ) {}

  generateAuthorizationURL(scopes: string[]): OAuthAuthorization {
    const state = generateState();
    const pkce = generatePKCE();
    const url = new URL(this.options.endpoints.authorize);
    url.searchParams.set("client_id", this.options.clientId);
    url.searchParams.set("redirect_uri", this.options.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", scopes.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", pkce.challenge);
    url.searchParams.set("code_challenge_method", "S256");
    return { url: url.toString(), state, verifier: pkce.verifier };
  }

  async exchange(code: string, verifier: string): Promise<Credentials.OAuth> {
    const res = await this.fetch(this.options.endpoints.token, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: this.options.clientId,
        redirect_uri: this.options.redirectUri,
      }),
    });
    return await extractCredentialsFromResponse(res);
  }

  async refresh(credentials: Credentials.OAuth): Promise<Credentials.OAuth> {
    const res = await this.fetch(this.options.endpoints.token, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: credentials.refresh,
        client_id: this.options.clientId,
        redirect_uri: this.options.redirectUri,
      }),
    });
    return await extractCredentialsFromResponse(res);
  }

  async revoke(credentials: Credentials.OAuth): Promise<void> {
    await this.fetch(this.options.endpoints.revoke, {
      method: "POST",
      body: new URLSearchParams({
        refresh_token: credentials.refresh,
        client_id: this.options.clientId,
        redirect_uri: this.options.redirectUri,
      }),
    });
  }

  private async fetch(url: string, init: RequestInit) {
    const res = await fetch(url, init);
    if (!res.ok) {
      const json = await res.json();
      throw new OAuthError(json as OAuthErrorResponse);
    }
    return res;
  }

  async callback(
    authorization: OAuthAuthorization,
  ): Promise<Credentials.OAuth> {
    const { pathname, port } = new URL(this.options.redirectUri);
    const promise = new DeferredPromise<Credentials.OAuth>();
    const handle = async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname !== pathname) {
        throw new OAuthError({
          error: "invalid_request",
          error_description: "Invalid redirect URI",
        });
      }
      const error = url.searchParams.get("error");
      const errorDescription = url.searchParams.get("error_description");
      if (error) {
        throw new OAuthError({
          error,
          error_description: errorDescription ?? "An unknown error occurred.",
        });
      }
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state) {
        throw new OAuthError({
          error: "invalid_request",
          error_description: "Missing code or state",
        });
      }
      if (state !== authorization.state) {
        throw new OAuthError({
          error: "invalid_request",
          error_description: "Invalid state",
        });
      }
      return await this.exchange(code, authorization.verifier);
    };
    const server = new HTTPServer({
      fetch: async (req) => {
        try {
          const credentials = await handle(req);
          promise.resolve(credentials);
          return Response.redirect("http://alchemy.run/auth/success");
        } catch (error) {
          promise.reject(error);
          return Response.redirect("http://alchemy.run/auth/error");
        }
      },
    });
    await server.listen(Number(port));
    const timeout = setTimeout(
      () => {
        promise.reject(
          new OAuthError({
            error: "timeout",
            error_description: "The authorization process timed out.",
          }),
        );
      },
      1000 * 60 * 5,
    );
    try {
      const credentials = await promise.value;
      clearTimeout(timeout);
      return credentials;
    } finally {
      // Not awaited because the server can take a few seconds to close, don't want to block the login process from completing
      void server.close();
    }
  }
}

interface OAuthErrorResponse {
  error: string;
  error_description: string;
}

interface OAuthSuccessResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

interface OAuthAuthorization {
  url: string;
  state: string;
  verifier: string;
}

async function extractCredentialsFromResponse(
  response: Response,
): Promise<Credentials.OAuth> {
  const json = (await response.json()) as OAuthSuccessResponse;
  return {
    type: "oauth",
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
    scopes: json.scope.split(" "),
  };
}

function generateState(length = 32) {
  return crypto.randomBytes(length).toString("base64url");
}

function generatePKCE(length = 96) {
  const verifier = crypto.randomBytes(length).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return { verifier, challenge };
}
