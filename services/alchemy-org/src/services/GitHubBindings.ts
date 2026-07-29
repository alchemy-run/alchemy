/**
 * The GitHub capability bindings, one seam with two physics. Every
 * tool and process resolves binding TAGS (`GitHub.CreateIssueComment`,
 * `GitHub.ListIssues`, …) — which implementation answers is decided
 * here, per substrate:
 *
 * - {@link GitHubLocal} — the `*Local` flavors: straight Octokit calls
 *   with the ALCHEMY PROFILE's credentials (the GitHub AuthProvider,
 *   `alchemy login` — no shell env token needed).
 * - {@link GitHubWorker} — the `*Http` flavors: each host mints ONE
 *   {@link GitHub.PersonalAccessToken} resource at deploy (FQN-memoized
 *   across bindings) and authenticates with the token bound into the
 *   Worker's environment as a secret.
 */
import * as Auth from "alchemy/Auth";
import * as GitHub from "alchemy/GitHub";
import * as Layer from "effect/Layer";

/**
 * The AuthProviders registry, WITH GitHub registered: the CLI provides
 * this for commands; a standalone runtime brings its own. `fresh`
 * matters: the registration layer is memoized by REFERENCE, and at
 * plan time the CLI's own graph already built it against the CLI's
 * registry — without `fresh`, ours would stay empty.
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

const HttpBindings = Layer.mergeAll(
  GitHub.CreateIssueCommentHttp,
  GitHub.CreatePullRequestHttp,
  GitHub.GetIssueHttp,
  GitHub.GetPullRequestHttp,
  GitHub.ListIssuesHttp,
  GitHub.ListPullRequestReviewsHttp,
  GitHub.ListPullRequestsHttp,
  GitHub.MergePullRequestHttp,
  GitHub.SearchIssuesHttp,
  GitHub.UpdateIssueHttp,
);

/**
 * The `yield* PersonalAccessToken` inside each `*Http` layer yields
 * the resource CONSTRUCTOR — a requirement the stack satisfies at
 * plan time (the same erasure Cloudflare's own webhook event source
 * makes for its `yield* Webhook`); it never exists at runtime, where
 * the bound token answers.
 */
export const GitHubWorker = HttpBindings as Layer.Layer<
  Layer.Success<typeof HttpBindings>,
  Layer.Error<typeof HttpBindings>,
  Exclude<
    Layer.Services<typeof HttpBindings>,
    GitHub.PersonalAccessToken
  >
>;
