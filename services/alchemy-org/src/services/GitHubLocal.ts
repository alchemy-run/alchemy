/**
 * GitHub local bindings — Octokit via the alchemy profile (`alchemy login`).
 * Worker code must not import this module (see GitHubBindingsWorker.ts).
 */
import * as Auth from "alchemy/Auth";
import * as GitHub from "alchemy/GitHub";
import * as Layer from "effect/Layer";

/**
 * The AuthProviders registry, WITH GitHub registered. `fresh` matters:
 * the registration layer is memoized by REFERENCE, and at plan time the
 * CLI's own graph already built it against the CLI's registry — without
 * `fresh`, ours would stay empty.
 */
const AuthRegistry = Layer.fresh(GitHub.Auth.GitHubAuth).pipe(
  Layer.provideMerge(Layer.succeed(Auth.AuthProviders, {})),
);

export const Credentials = GitHub.fromAuthProvider().pipe(
  Layer.provide(AuthRegistry),
  Layer.provide(Auth.ProfileLive),
  Layer.provide(Auth.CredentialsStoreLive),
);

export const GitHubLocal = Layer.mergeAll(
  GitHub.CreateIssueCommentLocal,
  GitHub.CreatePullRequestLocal,
  GitHub.GetIssueLocal,
  GitHub.GetPullRequestLocal,
  GitHub.ListIssuesLocal,
  GitHub.ListPullRequestReviewsLocal,
  GitHub.ListPullRequestsLocal,
  GitHub.MergePullRequestLocal,
  GitHub.SearchIssuesLocal,
  GitHub.UpdateIssueLocal,
).pipe(Layer.provideMerge(Credentials));
