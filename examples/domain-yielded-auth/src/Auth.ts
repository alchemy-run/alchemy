import { Auth, AuthContract, OAuth, Sessions } from "@yielded/auth";
import * as GitHub from "@yielded/auth/GitHub";
import * as Google from "@yielded/auth/Google";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { VerifySession } from "./VerifySession.ts";

/** Sign-in with GitHub or Google, shared by the server and the browser. */
export const AuthApi = AuthContract.make("notes/Auth", {
  claims: Schema.Struct({ displayName: Schema.String }),
  actions: (sessions) => ({
    signIn: AuthContract.oauthSignIn(),
    completeSignIn: AuthContract.oauthCompleteSignIn(sessions),
  }),
});

/** yielded's auth for the notes app: signed sessions, GitHub and Google. */
export const AppAuth = Auth.make(AuthApi, {
  sessions: Sessions.stateless(),
  strategies: {
    oauth: OAuth.make({
      profiles: { github: GitHub.GitHubUserProfile, google: Google.GoogleUserProfile },
    }),
  },
  defaultStrategy: "oauth",
});

/** The Api checks sessions with yielded's `verifySession`. */
export const VerifySessionLive = Layer.effect(
  VerifySession,
  Effect.map(AppAuth, (auth) => auth.verifySession),
);
