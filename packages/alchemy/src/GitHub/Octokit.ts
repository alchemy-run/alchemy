import type { Octokit as _Octokit } from "@octokit/rest";
import * as Effect from "effect/Effect";
import { GitHubCredentials } from "./Credentials.ts";

export const Octokit: Effect.Effect<_Octokit, never, GitHubCredentials> =
  Effect.gen(function* () {
    const creds = yield* yield* GitHubCredentials;
    return creds.octokit();
  });
