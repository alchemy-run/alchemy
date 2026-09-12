import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Git from "../Git/Credentials.ts";
import { GitHubCredentials } from "./Credentials.ts";

const GITHUB_HOST = /^https:\/\/github\.com\//;

/**
 * GitHub's answer to the {@link Git.Credentials} helper protocol: for
 * `github.com` remotes, the token from the {@link GitHubCredentials}
 * chain as `x-access-token`; every other host gets `None` so other
 * helpers (or anonymous access) can answer.
 */
export const GitCredentials: Layer.Layer<
  Git.Credentials,
  never,
  GitHubCredentials
> = Layer.effect(
  Git.Credentials,
  Effect.gen(function* () {
    const credentials = yield* GitHubCredentials;
    return {
      for: (remote) =>
        GITHUB_HOST.test(remote.url)
          ? Effect.map(credentials, ({ token }) =>
              Option.some({ username: "x-access-token", password: token }),
            )
          : Effect.succeedNone,
    };
  }),
);
