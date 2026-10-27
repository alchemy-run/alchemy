import { Http } from "@yielded/auth";
import * as GitHub from "@yielded/auth/GitHub";
import * as Google from "@yielded/auth/Google";
import type * as Redacted from "effect/Redacted";
import { AppAuth } from "./Auth.ts";

interface Client {
  readonly clientId: string;
  readonly clientSecret: Redacted.Redacted<string>;
}

/** yielded's sign-in routes for the app's origin: GitHub and Google send users back to /auth/<provider>/callback. */
export const makeAuthHttp = (config: {
  readonly origin: string;
  readonly github: Client;
  readonly google: Client;
}) =>
  Http.make(AppAuth, {
    origin: config.origin,
    oauth: {
      providers: {
        github: GitHub.provider(config.github),
        google: Google.provider({ ...config.google, scopes: ["openid", "profile", "email"] }),
      },
    },
  });
