/**
 * Tool physics for the org's contracts — ALL STUBS. Wire real physics
 * before deploying: a DevBox container (Cloudflare Container) for
 * Bash/Grep/ReadFile/EditFile over the alchemy-effect checkout (with
 * the distilled submodule embedded), Octokit for the GitHub tools, and
 * a human-approval surface (or an automated gate) for Approve.
 *
 * Each tool interface is a `Context.Service`, so an implementation is an
 * ordinary Layer — and because `AI.layer(agent)` closes over its own
 * provisioning, different agents in the same Worker can hold different
 * physics for the same contract.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  Approve,
  Bash,
  EditFile,
  Grep,
  MergePullRequest,
  OpenPullRequest,
  ReadFile,
  Comment,
  SearchIssues,
} from "./tools.ts";

const todo = (what: string) => () =>
  Effect.die(new Error(`TODO(wire real physics before deploying): ${what}`));

/** Read-write sandbox — the Engineer's Bash (a Cloudflare Container
 * holding the alchemy-effect checkout, distilled submodule included). */
export const BashDevBox = Layer.succeed(
  Bash,
  todo("exec in the DevBox container"),
);

export const GrepLive = Layer.succeed(
  Grep,
  todo("ripgrep over the workspace"),
);
export const ReadFileLive = Layer.succeed(
  ReadFile,
  todo("read from the workspace"),
);
export const EditFileLive = Layer.succeed(
  EditFile,
  todo("edit in the DevBox"),
);

// GitHub-side effects (Octokit in the real implementation)
export const SearchIssuesLive = Layer.succeed(
  SearchIssues,
  todo("GitHub search API"),
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

// the autonomy dial: whether the org is human-supervised (orchestra) or
// autonomous (factory) is decided by which Layer implements Approve for
// the Reviewer — e.g. ApproveHuman (Slack + durable waitForEvent) vs
// ApproveAuto in CI — never by the charter.
export const ApproveHumanLive = Layer.succeed(
  Approve,
  todo("Slack approval + durable waitForEvent"),
);
