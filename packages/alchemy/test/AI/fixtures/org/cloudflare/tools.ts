/**
 * MOCK Cloudflare tool physics for the org's tool contracts.
 *
 * Each tool interface (test/AI/fixtures/org/tools.ts) is a
 * `Context.Service`, so an implementation is an ordinary Layer — and
 * because `AI.layer(agent)` closes over its own provisioning, different
 * agents in the same Worker can hold different physics for the same
 * contract.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  Approve,
  Bash,
  CreateIssue,
  EditFile,
  Grep,
  MergePullRequest,
  OpenPullRequest,
  ReadFile,
  Comment,
  SearchIssues,
} from "../tools.ts";

const todo = (what: string) => () =>
  Effect.die(new Error(`TODO(Phase 3): ${what}`));

/** Read-write sandbox — the Engineer's Bash (a Cloudflare Container). */
export const BashDevBox = Layer.succeed(
  Bash,
  todo("exec in the DevBox container"),
);

export const GrepLive = Layer.succeed(Grep, todo("ripgrep over the repo"));
export const ReadFileLive = Layer.succeed(ReadFile, todo("read from the repo"));
export const EditFileLive = Layer.succeed(EditFile, todo("edit in the DevBox"));

// GitHub-side effects (Octokit in the real implementation)
export const SearchIssuesLive = Layer.succeed(
  SearchIssues,
  todo("GitHub search API"),
);
export const CreateIssueLive = Layer.succeed(
  CreateIssue,
  todo("GitHub issues API"),
);
export const OpenPullRequestLive = Layer.succeed(
  OpenPullRequest,
  todo("GitHub pulls API"),
);
export const MergePullRequestLive = Layer.succeed(
  MergePullRequest,
  todo("GitHub merge API — refuses without an approved review"),
);

// surface-specific reply (GitHub issue / PR review comment)
export const CommentLive = Layer.succeed(Comment, todo("reply on the surface"));

// the autonomy dial: whether ResolveGitHubIssue is human-supervised (orchestra)
// or autonomous (factory) is decided by which Layer implements Approve
// for the Reviewer — e.g. ApproveHuman (Slack + durable waitForEvent)
// vs ApproveAuto in CI — never by the charter.
export const ApproveHumanLive = Layer.succeed(
  Approve,
  todo("Slack approval + DO waitForEvent (≤7 days)"),
);
