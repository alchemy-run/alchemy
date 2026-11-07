/**
 * E2B's browser login, as the E2B CLI runs it (`e2b auth login`).
 *
 * E2B's console signs the user in and redirects to a loopback URL with the
 * OAuth grant in the query string: a short-lived JWT access token, a refresh
 * token, and the token and revoke endpoints with the public client id they
 * were issued to. Refresh and revoke are standard OAuth 2 requests against
 * those endpoints.
 */
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

export class E2BLoginError extends Data.TaggedError("E2BLoginError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** The grant E2B's console hands the loopback listener. */
export interface E2BGrant {
  readonly email: string;
  readonly access: Redacted.Redacted<string>;
  readonly refresh: Redacted.Redacted<string>;
  readonly tokenEndpoint: string;
  readonly revokeEndpoint: string;
  readonly clientId: string;
  /** Epoch millis the access token expires at. */
  readonly expires: number;
}

/**
 * The E2B CLI release whose login flow this mirrors. E2B's console reads
 * `cliVersion` and refuses ("CLI update required") a login without a current
 * one. Bump it with the E2B CLI if the console starts refusing it.
 */
export const E2B_CLI_COMPAT_VERSION = "2.23.0";

/** Where the console's CLI login starts, and where it shows the outcome. */
const loginBase = (domain: string) =>
  `https://${domain === "e2b.app" ? "e2b.dev" : domain}/docs/api/cli`;

/** A JWT's `exp`, in epoch millis; 0 when it has none, so it refreshes at once. */
export const jwtExpiry = (token: string): number => {
  const payload = token.split(".")[1];
  if (payload === undefined) return 0;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      exp?: number;
    };
    return typeof decoded.exp === "number" ? decoded.exp * 1000 : 0;
  } catch {
    return 0;
  }
};

const isLoginError = (value: E2BGrant | E2BLoginError): value is E2BLoginError => "_tag" in value;

const grantOf = (params: URLSearchParams): E2BGrant | E2BLoginError => {
  const error = params.get("error");
  if (error) return new E2BLoginError({ message: `E2B login failed: ${error}` });
  const field = (name: string) => params.get(name) ?? "";
  const grant = {
    email: field("email"),
    accessToken: field("accessToken"),
    refreshToken: field("refreshToken"),
    tokenEndpoint: field("tokenEndpoint"),
    revokeEndpoint: field("revokeEndpoint"),
    clientId: field("clientId"),
  };
  const missing = Object.entries(grant)
    .filter(([, value]) => value === "")
    .map(([key]) => key);
  if (missing.length > 0) {
    return new E2BLoginError({
      message: `E2B login returned an incomplete grant (missing ${missing.join(", ")})`,
    });
  }
  return {
    email: grant.email,
    access: Redacted.make(grant.accessToken),
    refresh: Redacted.make(grant.refreshToken),
    tokenEndpoint: grant.tokenEndpoint,
    revokeEndpoint: grant.revokeEndpoint,
    clientId: grant.clientId,
    expires: jwtExpiry(grant.accessToken),
  };
};

/** Parses a pasted loopback URL (the manual fallback when the listener can't be reached). */
export const grantFromUrl = (input: string): Effect.Effect<E2BGrant, E2BLoginError> =>
  Effect.gen(function* () {
    const url = yield* Effect.try({
      try: () => new URL(input.trim()),
      catch: () => new E2BLoginError({ message: "Paste the full URL the browser was sent to" }),
    });
    const grant = grantOf(url.searchParams);
    return isLoginError(grant) ? yield* grant : grant;
  });

/**
 * Starts the loopback listener on a free port and returns the console URL
 * to open, plus the grant it receives. The listener closes with the scope.
 */
export const startLogin = Effect.fn(function* (domain: string) {
  const base = loginBase(domain);
  const received = yield* Deferred.make<E2BGrant, E2BLoginError>();
  const server = yield* Effect.acquireRelease(
    Effect.callback<http.Server, E2BLoginError>((resume) => {
      const server = http.createServer((req, res) => {
        const params = new URL(req.url ?? "/", "http://localhost").searchParams;
        const grant = grantOf(params);
        const outcome = new URL(base);
        if (isLoginError(grant)) {
          outcome.searchParams.set("state", "error");
          outcome.searchParams.set("error", grant.message);
        } else {
          outcome.searchParams.set("state", "success");
          outcome.searchParams.set("email", grant.email);
        }
        res.writeHead(302, { Location: outcome.href, Connection: "close" });
        res.end();
        Deferred.doneUnsafe(
          received,
          isLoginError(grant) ? Effect.fail(grant) : Effect.succeed(grant),
        );
      });
      server.once("error", (cause) =>
        resume(
          Effect.fail(new E2BLoginError({ message: "Could not start the login listener", cause })),
        ),
      );
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
    }),
    (server) =>
      Effect.sync(() => {
        server.close();
        server.closeAllConnections();
      }),
  );
  const { port } = server.address() as AddressInfo;
  const url = new URL(base);
  url.searchParams.set("next", `http://localhost:${port}`);
  url.searchParams.set("cliVersion", E2B_CLI_COMPAT_VERSION);
  return { url: url.href, grant: Deferred.await(received) };
});

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
});

/** Exchanges the refresh token for a fresh access token (refresh tokens may rotate). */
export const refreshGrant = (grant: E2BGrant): Effect.Effect<E2BGrant, E2BLoginError> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    // Raw HTTP: the token endpoint the console's login redirect handed back.
    const response = yield* client.execute(
      HttpClientRequest.post(grant.tokenEndpoint).pipe(
        HttpClientRequest.setHeader("Accept", "application/json"),
        HttpClientRequest.bodyUrlParams({
          grant_type: "refresh_token",
          refresh_token: Redacted.value(grant.refresh),
          client_id: grant.clientId,
        }),
      ),
    );
    if (response.status >= 400) {
      const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
      return yield* new E2BLoginError({
        message: `E2B token refresh failed (${response.status}): ${body.slice(0, 200)}`,
      });
    }
    const tokens = yield* Schema.decodeUnknownEffect(TokenResponse)(yield* response.json);
    return {
      ...grant,
      access: Redacted.make(tokens.access_token),
      refresh:
        tokens.refresh_token === undefined ? grant.refresh : Redacted.make(tokens.refresh_token),
      expires: jwtExpiry(tokens.access_token),
    };
  }).pipe(
    Effect.catchIf(
      (e): e is Exclude<typeof e, E2BLoginError> => e._tag !== "E2BLoginError",
      (cause) => Effect.fail(new E2BLoginError({ message: "E2B token refresh failed", cause })),
    ),
    Effect.provide(FetchHttpClient.layer),
  );

/** Revokes the refresh token; best effort, like `e2b auth logout`. */
export const revokeGrant = (grant: Pick<E2BGrant, "refresh" | "revokeEndpoint" | "clientId">) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    yield* client.execute(
      // Raw HTTP: the revoke endpoint the console's login redirect handed back.
      HttpClientRequest.post(grant.revokeEndpoint).pipe(
        HttpClientRequest.bodyUrlParams({
          token: Redacted.value(grant.refresh),
          token_type_hint: "refresh_token",
          client_id: grant.clientId,
        }),
      ),
    );
  }).pipe(Effect.ignore, Effect.provide(FetchHttpClient.layer));
