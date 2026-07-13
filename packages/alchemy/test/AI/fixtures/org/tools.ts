/**
 * Tool interfaces of the organization. Pure contracts — physics comes from
 * Layers (a DevBox container for Bash/Grep/ReadFile/EditFile, Octokit for
 * the GitHub tools, a human or an automated system for Approve/AskHuman).
 *
 * The autonomy dial: `Approve` and `AskHuman` are ordinary Tools. Whether a
 * ring is human-supervised or autonomous is decided by which Layer
 * implements them for that ring (`ApproveHuman` posts to #maintainers and
 * durably waits; `ApproveAuto` runs the test suite) — never by the charter.
 * `AskHuman` stays in the catalog even while no charter interpolates it:
 * capability by omission is a fact about Req, not about the vocabulary.
 */
import * as AI from "@/AI/index.ts";
import { command, issue, message, path, pattern, pr } from "./vocabulary.ts";

// ── sandboxed repository access ────────────────────────────────

export class Grep extends AI.Tool<Grep>()("grep")`
Search the repository for ${pattern}. Returns matching paths and
lines. Cheap — always search before you read.` {}

export class ReadFile extends AI.Tool<ReadFile>()("readFile")`
Read the file at ${path}.` {}

export class EditFile extends AI.Tool<EditFile>()("editFile")`
Replace the contents of the file at ${path}.` {}

export class Bash extends AI.Tool<Bash>()("bash")`
Run ${command} in the sandboxed DevBox and return stdout, stderr,
and the exit code. The test suite is the only oracle of done-ness.` {}

// ── GitHub ─────────────────────────────────────────────────────

export class SearchIssues extends AI.Tool<SearchIssues>()("searchIssues")`
Search issues and pull requests across our repositories for
${pattern}. Use before filing anything — duplicates are debt.` {}

export class CreateIssue extends AI.Tool<CreateIssue>()("createIssue")`
File a new ${issue}. Title in conventional-commit style; body must
contain a minimal reproduction or a checklist of acceptance
criteria verifiable by a command or test.` {}

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
and green checks — merging is the last act of a case, never a way
to skip review.` {}

// ── surfaces ───────────────────────────────────────────────────

export class Comment extends AI.Tool<Comment>()("comment")`
Comment ${message} on the GitHub issue or pull request that
triggered this work.` {}

// ── human-class tools (the autonomy dial) ──────────────────────

export class Approve extends AI.Tool<Approve>()("approve")`
Request approval to merge ${pr}. Returns approved, or rejected with
reasons you must address before asking again.` {}

export class AskHuman extends AI.Tool<AskHuman>()("askHuman")`
Escalate ${message} to a human maintainer and wait for an answer.
Use for anything touching secrets, state corruption, billing, or
intent you cannot infer from the repository.` {}
