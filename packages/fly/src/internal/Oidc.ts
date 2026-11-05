import * as http from "node:http";
import { OidcTokenError } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type * as rolldown from "rolldown";

/**
 * Fly Machine OIDC tokens. Every Machine serves part of the Machines API on
 * the `/.fly/api` socket, authenticated as that Machine, so a process can
 * mint a token without holding one. A token is signed by
 * `https://oidc.fly.io/<org>`, lives 10 minutes, and names its caller as
 * `sub = <org>:<app>:<machine>`. AWS and GCP trust it through an OIDC
 * provider, so a Fly host reaches them without a key Alchemy created.
 *
 * See https://fly.io/docs/security/openid-connect/.
 */

/** The socket a Machine serves its Machines API on. */
const FLY_API_SOCKET = "/.fly/api";

/** Fly's OIDC issuer for an organization. */
export const flyOidcIssuer = (orgSlug: string) => `https://oidc.fly.io/${orgSlug}`;

/**
 * Bundle options for a Fly Service: defines `__ALCHEMY_HOST_IDENTITY__` as
 * `"Fly.OIDC"` so bindings keep only the code that exchanges the Machine's
 * OIDC token, and drop the created-key path.
 */
export const flyHostBundle = (input: rolldown.InputOptions): rolldown.InputOptions => ({
  ...input,
  transform: {
    ...input.transform,
    define: {
      ...input.transform?.define,
      "globalThis.__ALCHEMY_HOST_IDENTITY__": JSON.stringify("Fly.OIDC"),
    },
  },
});

/** Mint an OIDC token for `audience` from the Machine's `/.fly/api` socket. */
export const flyOidcToken = (
  audience: string,
): Effect.Effect<Redacted.Redacted<string>, OidcTokenError> =>
  Effect.callback<Redacted.Redacted<string>, OidcTokenError>((resume) => {
    const body = JSON.stringify({ aud: audience });
    const request = http.request(
      {
        socketPath: FLY_API_SOCKET,
        path: "/v1/tokens/oidc",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          text += chunk;
        });
        response.on("end", () => {
          if (response.statusCode === 200 && text.trim().length > 0) {
            resume(Effect.succeed(Redacted.make(text.trim())));
          } else {
            resume(
              Effect.fail(
                new OidcTokenError({
                  message: `${FLY_API_SOCKET} returned HTTP ${response.statusCode} for an OIDC token: ${text.slice(0, 200)}`,
                }),
              ),
            );
          }
        });
        response.on("error", (cause) =>
          resume(
            Effect.fail(
              new OidcTokenError({
                message: `Reading the OIDC token from ${FLY_API_SOCKET}`,
                cause,
              }),
            ),
          ),
        );
      },
    );
    request.on("error", (cause) =>
      resume(
        Effect.fail(
          new OidcTokenError({
            message: `Cannot reach ${FLY_API_SOCKET} for an OIDC token. It is served only on Fly Machines, to root.`,
            cause,
          }),
        ),
      ),
    );
    request.end(body);
    return Effect.sync(() => request.destroy());
  });
