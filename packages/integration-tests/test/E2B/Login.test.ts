import {
  E2B_CLI_COMPAT_VERSION,
  grantFromUrl,
  jwtExpiry,
  startLogin,
} from "@alchemy.run/e2b/internal/Login";
import { expect, layer } from "@alchemy.run/test";
import { BunServices } from "@effect/platform-bun";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

const tags = ["unit", "provider:e2b", "local"];

/** An unsigned JWT whose `exp` is `exp` seconds since the epoch. */
const jwt = (exp: number) =>
  `e30.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.sig`;

/** A browser that stops at the listener's redirect instead of following it. */
const browser = Layer.mergeAll(
  FetchHttpClient.layer,
  Layer.succeed(FetchHttpClient.RequestInit, { redirect: "manual" }),
);

const grantParams = (access: string) =>
  new URLSearchParams({
    email: "dev@example.com",
    accessToken: access,
    refreshToken: "refresh-1",
    tokenEndpoint: "https://auth.example.com/token",
    revokeEndpoint: "https://auth.example.com/revoke",
    clientId: "client-1",
  });

layer(BunServices.layer)("E2B browser login", (test) => {
  test.effect(
    "the loopback listener receives the console's grant and sends the browser to the outcome page",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const login = yield* startLogin("e2b.app");
          const url = new URL(login.url);
          expect(url.origin + url.pathname).toBe("https://e2b.dev/docs/api/cli");
          const next = url.searchParams.get("next") ?? "";
          expect(next).toMatch(/^http:\/\/localhost:\d+$/);
          expect(url.searchParams.get("cliVersion")).toBe(E2B_CLI_COMPAT_VERSION);

          // What E2B's console does once the user signs in.
          const client = yield* HttpClient.HttpClient;
          const res = yield* client.execute(
            HttpClientRequest.get(`${next}/?${grantParams(jwt(2_000_000_000)).toString()}`),
          );
          expect(res.status).toBe(302);
          const outcome = new URL(res.headers.location ?? "");
          expect(outcome.searchParams.get("state")).toBe("success");
          expect(outcome.searchParams.get("email")).toBe("dev@example.com");

          const grant = yield* login.grant;
          expect(grant.email).toBe("dev@example.com");
          expect(Redacted.value(grant.refresh)).toBe("refresh-1");
          expect(grant.tokenEndpoint).toBe("https://auth.example.com/token");
          expect(grant.clientId).toBe("client-1");
          expect(grant.expires).toBe(2_000_000_000_000);
        }),
      ).pipe(Effect.provide(browser)),
    { tags },
  );

  test.effect(
    "an incomplete grant fails the login and shows the error page",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const login = yield* startLogin("e2b.app");
          const next = new URL(login.url).searchParams.get("next") ?? "";
          const client = yield* HttpClient.HttpClient;
          const res = yield* client.execute(
            HttpClientRequest.get(`${next}/?email=dev%40example.com`),
          );
          expect(new URL(res.headers.location ?? "").searchParams.get("state")).toBe("error");
          const failed = yield* login.grant.pipe(Effect.flip);
          expect(failed.message).toContain("missing accessToken");
        }),
      ).pipe(Effect.provide(browser)),
    { tags },
  );

  test.effect(
    "a pasted callback URL is accepted when the listener can't be reached",
    () =>
      Effect.gen(function* () {
        const grant = yield* grantFromUrl(
          `http://localhost:1234/?${grantParams(jwt(1_900_000_000)).toString()}`,
        );
        expect(grant.expires).toBe(1_900_000_000_000);
        const bad = yield* grantFromUrl("not a url").pipe(Effect.flip);
        expect(bad._tag).toBe("E2BLoginError");
      }),
    { tags },
  );

  test.effect(
    "a token without an exp counts as expired, so it is refreshed at once",
    () =>
      Effect.sync(() => {
        expect(jwtExpiry("opaque-token")).toBe(0);
        expect(jwtExpiry(jwt(1_800_000_000))).toBe(1_800_000_000_000);
      }),
    { tags },
  );
});
