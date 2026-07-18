/**
 * Physics for the org's GitHub TOOL contracts — thin adapters from the
 * charters' tool vocabulary to the GitHub API bindings
 * (`GitHub.SearchIssues(repo)`, `GitHub.CreateIssueComment(repo)`, …).
 * No Octokit here: the bindings' `*Http` layers own the wire; these
 * layers own the org's business rules (merge refuses without an
 * approved review) and the model-facing rendering.
 *
 * Every layer binds the API to the ONE managed repository at Layer
 * build; provide the `GitHub.*Http` implementations (+ credentials) at
 * composition.
 *
 * Failure discipline: operational errors are `Effect.fail(text)` —
 * model-visible tool failures the agent reacts to — never defects.
 */
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { testAlchemy } from "./repos.ts";
import {
  Approve,
  CloseIssue,
  Comment,
  LinkIssues,
  MergePullRequest,
  OpenIssue,
  OpenPullRequest,
  SearchIssues,
} from "./tools.ts";

/** Render a wire failure model-visibly. */
const asToolFailure = (error: GitHub.GitHubApiError) =>
  `${error.operation} failed: ${error.message}`;

/** Search issues + pull requests in the managed repository. */
export const SearchIssuesLive = Layer.effect(
  SearchIssues,
  Effect.gen(function* () {
    const search = yield* GitHub.SearchIssues(testAlchemy);
    return ((input: { pattern: string }) =>
      Effect.gen(function* () {
        const results = yield* search({
          q: input.pattern,
          per_page: 20,
        }).pipe(Effect.mapError(asToolFailure));
        if (results.items.length === 0) return "no matches";
        return results.items
          .map(
            (item) =>
              `#${item.number} [${item.state}${item.pull_request ? ", PR" : ""}] ${item.title}`,
          )
          .join("\n");
      })) as never;
  }),
);

/** Comment on an issue or pull request (one door — GitHub's issues API). */
export const CommentLive = Layer.effect(
  Comment,
  Effect.gen(function* () {
    const comment = yield* GitHub.CreateIssueComment(testAlchemy);
    return ((input: {
      message: string;
      issue: { owner: string; repository: string; number: number };
    }) =>
      Effect.gen(function* () {
        const created = yield* comment({
          issue_number: input.issue.number,
          body: input.message,
        }).pipe(Effect.mapError(asToolFailure));
        return `commented: ${created.html_url}`;
      })) as never;
  }),
);

/**
 * Merge a pull request — refuses without an approved review (the tool's
 * own prose promises this; this layer enforces it over the RAW
 * `GitHub.MergePullRequest` binding).
 */
export const MergePullRequestLive = Layer.effect(
  MergePullRequest,
  Effect.gen(function* () {
    const listReviews = yield* GitHub.ListPullRequestReviews(testAlchemy);
    const merge = yield* GitHub.MergePullRequest(testAlchemy);
    return ((input: {
      pr: { owner: string; repository: string; number: number; url: string };
    }) =>
      Effect.gen(function* () {
        const reviews = yield* listReviews({
          pull_number: input.pr.number,
        }).pipe(Effect.mapError(asToolFailure));
        if (!reviews.some((review) => review.state === "APPROVED")) {
          return yield* Effect.fail(
            `refusing to merge #${input.pr.number}: no approved review — ask the Reviewer first`,
          );
        }
        const merged = yield* merge({ pull_number: input.pr.number }).pipe(
          Effect.mapError(asToolFailure),
        );
        return `merged #${input.pr.number}: ${merged.sha}`;
      })) as never;
  }),
);

/**
 * Linking's physics today is a comment naming the relation — GitHub
 * renders the cross-reference on both issues, which is the durable
 * artifact the charter wants. A future `GitHub.UpdateIssue` binding
 * could add real duplicate-marking; the contract won't change.
 */
export const LinkIssuesLive = Layer.effect(
  LinkIssues,
  Effect.gen(function* () {
    const comment = yield* GitHub.CreateIssueComment(testAlchemy);
    return ((input: {
      issue: { number: number };
      related: { number: number };
      reason: string;
    }) =>
      Effect.gen(function* () {
        const created = yield* comment({
          issue_number: input.issue.number,
          body: `Related to #${input.related.number} — ${input.reason}`,
        }).pipe(Effect.mapError(asToolFailure));
        return `linked #${input.issue.number} → #${input.related.number}: ${created.html_url}`;
      })) as never;
  }),
);

/**
 * TODO(binding): needs `GitHub.CreateIssue` / `GitHub.UpdateIssue`
 * bindings (create + close are one Octokit call each). Until they
 * land these fail MODEL-VISIBLY so a live run degrades to reporting
 * instead of crashing.
 */
export const OpenIssueLive = Layer.succeed(
  OpenIssue,
  ((input: { title: string }) =>
    Effect.fail(
      `openIssue is not wired yet (GitHub.CreateIssue binding is TODO): ` +
        `report the drafted issue ${JSON.stringify(input.title)} in your reply instead`,
    )) as never,
);

export const CloseIssueLive = Layer.succeed(
  CloseIssue,
  ((input: { issue: { number: number }; reason: string }) =>
    Effect.fail(
      `closeIssue is not wired yet (GitHub.UpdateIssue binding is TODO): ` +
        `comment the close rationale on #${input.issue.number} instead — ${input.reason}`,
    )) as never,
);

/**
 * TODO(workspace): opening a pull request needs branch-push plumbing —
 * the Engineer's workspace must commit to a branch and push it before
 * a PR can reference it (the Workspace component from the factory
 * catalog owns that). Until it lands this fails MODEL-VISIBLY (not a
 * defect) so a live run degrades to reporting instead of crashing.
 */
export const OpenPullRequestLive = Layer.succeed(
  OpenPullRequest,
  ((input: { issue: { number: number } }) =>
    Effect.fail(
      `openPullRequest is not wired yet (branch-push plumbing is TODO): ` +
        `describe the change for issue #${input.issue.number} in a comment instead`,
    )) as never,
);

/**
 * The autonomy dial's LOCAL position: log the request and auto-approve,
 * loudly. TODO(HumanGate): replace with a real approval surface (Slack /
 * GitHub review / console prompt) — the human gate is deliberately
 * visible in every approval this returns.
 */
export const ApproveConsole = Layer.succeed(
  Approve,
  ((input: {
    pr: { owner: string; repository: string; number: number; url: string };
  }) =>
    Effect.gen(function* () {
      yield* Effect.logWarning(
        `ApproveConsole AUTO-APPROVING ${input.pr.owner}/${input.pr.repository}#${input.pr.number} — no human gate is wired (TODO: HumanGate)`,
      );
      return `approved (WARNING: auto-approved by ApproveConsole — no human reviewed this)`;
    })) as never,
);
