/**
 * MOCK Cloudflare tool physics for the org's tool contracts.
 *
 * Each tool interface (test/AI/fixtures/org/tools.ts) is a
 * `Context.Service`, so an implementation is an ordinary Layer — and
 * because `AI.layer(agent)` closes over its own provisioning, *different
 * agents in the same Worker can hold different physics for the same
 * contract*. The two `Bash` layers below are the demonstration:
 *
 * - `BashDevBox` — read-write sandbox (Engineer): a Cloudflare Container
 *   in the real implementation.
 * - `BashReadOnly` — the same contract for the Judge, refusing mutation;
 *   the verifier can run the suite but never edit the world it grades.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  Approve,
  AskHuman,
  Bash,
  CreateIssue,
  EditFile,
  Grep,
  OpenPullRequest,
  ReadFile,
  Reply,
  SearchIssues,
} from "../tools.ts";

const todo = (what: string) => () =>
  Effect.die(new Error(`TODO(Phase 3): ${what}`));

/** Read-write sandbox — Engineer's Bash (Cloudflare Container). */
export const BashDevBox = Layer.succeed(
  Bash,
  todo("exec in the DevBox container"),
);

/** Same contract, verifier physics: run and read, never mutate. */
export const BashReadOnly = Layer.succeed(Bash, (input) =>
  /^\s*(rm|mv|git\s+push|npm\s+publish)\b/.test(String(input.command))
    ? Effect.die(new Error("BashReadOnly: mutation refused for the verifier"))
    : Effect.die(new Error("TODO(Phase 3): exec (read-only) in the container")),
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

// surface-specific reply (Discord thread / GitHub PR comment)
export const ReplyLive = Layer.succeed(Reply, todo("reply on the surface"));

// human-class tools: the autonomy dial. These mocks are where a real
// deployment chooses orchestra vs factory per ring — e.g. ApproveHuman
// (Slack + durable waitForEvent) for Flywheel vs ApproveAuto in CI.
export const ApproveHumanLive = Layer.succeed(
  Approve,
  todo("Slack approval + DO waitForEvent (≤7 days)"),
);
export const AskHumanLive = Layer.succeed(
  AskHuman,
  todo("post question to #maintainers, resume on answer"),
);
