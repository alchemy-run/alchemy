/**
 * Tool interfaces of the organization. Pure contracts — physics comes
 * from Layers (local FileSystem/shell physics in toolbox.ts, Octokit in
 * github-tools.ts, a console or human surface for Approve). Which Layer
 * implements a contract is an entrypoint decision, never the charter's.
 *
 * The autonomy dial: `Approve` is an ordinary Tool. Whether the org is
 * human-supervised or autonomous is decided by which Layer implements it
 * for the Reviewer — never by the charter.
 */
import * as AI from "alchemy/AI";
import {
  command,
  content,
  issue,
  message,
  path,
  pattern,
  pr,
} from "./vocabulary.ts";

// ── sandboxed workspace access ─────────────────────────────────

export class Grep extends AI.Tool<Grep>()("grep")`
Search the workspace for ${pattern}. Returns matching paths and
lines. Cheap — always search before you read.` {}

export class ReadFile extends AI.Tool<ReadFile>()("readFile")`
Read the file at ${path}.` {}

export class EditFile extends AI.Tool<EditFile>()("editFile")`
Replace the file at ${path} with ${content}.` {}

export class Bash extends AI.Tool<Bash>()("bash")`
Run ${command} in the sandboxed workspace and return stdout, stderr,
and the exit code. The test suite is the only oracle of done-ness.` {}

// ── GitHub ─────────────────────────────────────────────────────

export class SearchIssues extends AI.Tool<SearchIssues>()("searchIssues")`
Search issues and pull requests in the repository for ${pattern}.
Use before filing anything — duplicates are debt.` {}

export class OpenPullRequest extends AI.Tool<OpenPullRequest>()(
  "openPullRequest",
)`
Open a pull request resolving ${issue}. Returns the created ${pr}.
The PR body must cite the issue and the evidence that criteria are
met.` {}

export class MergePullRequest extends AI.Tool<MergePullRequest>()(
  "mergePullRequest",
)`
Merge ${pr}. Fails unless the pull request has an approved review
and green checks — merging is the last act of resolving an issue,
never a way to skip review.` {}

// ── surfaces ───────────────────────────────────────────────────

export class Comment extends AI.Tool<Comment>()("comment")`
Comment ${message} on ${issue}.` {}

// ── human-class tools (the autonomy dial) ──────────────────────

export class Approve extends AI.Tool<Approve>()("approve")`
Request approval to merge ${pr}. Returns approved, or rejected with
reasons you must address before asking again.` {}
