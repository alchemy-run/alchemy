import * as AI from "alchemy/AI";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as S from "effect/Schema";
import { PublishToken } from "../github/PublishToken.ts";
import { gitIn, originOf } from "./Origin.ts";

const branch = AI.Thing("branch", S.String)`
  Branch name to publish the tree's current HEAD as (e.g.
  "agent/fix-runner-timeout"). Never a protected branch — publish a
  topic branch and open a pull request.`;

const remote = AI.Thing("remote", S.String)`
  The repository the branch landed on — "owner/repo".`;

const pushed = AI.Thing("pushed", S.String)`
  The branch name the push created or updated.`;

export class PushBranch extends (AI.Tool<PushBranch>(import.meta)("pushBranch")`
  Publish your work: push the tree's current HEAD to the origin
  repository as ${branch} — answers ${AI.out(remote, pushed)}. Commit
  first (bash: git add / git commit) — this pushes exactly what HEAD
  points at. Authentication is handled for you.`) {}

/**
 * Push over the session sandbox: the token rides the push URL for the
 * one command (never written to the tree, never stored in the image).
 */
export const PushBranchLive = Layer.effect(
  PushBranch,
  Effect.gen(function* () {
    const sandbox = yield* AI.Sandbox;
    const token = yield* PublishToken;
    const git = gitIn(sandbox);

    return ((input: { branch: string }) =>
      Effect.gen(function* () {
        const origin = yield* originOf(git);
        const value = Redacted.value(yield* token);
        const pushUrl = `https://x-access-token:${value}@github.com/${origin.owner}/${origin.repository}.git`;
        yield* git(["push", pushUrl, `HEAD:refs/heads/${input.branch}`], {
          timeout: 300_000,
        }).pipe(
          // the push URL carries the credential — never echo it back
          Effect.mapError((error) => error.replaceAll(value, "<token>")),
        );
        return {
          remote: `${origin.owner}/${origin.repository}`,
          pushed: input.branch,
        };
      })) as never;
  }),
);
