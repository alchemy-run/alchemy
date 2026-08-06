/**
 * GitHub local bindings — as the review bot's GitHub APP when
 * `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` are configured, otherwise
 * Octokit via the alchemy profile (`alchemy login`). The app identity
 * is what lets the bot post real REQUEST_CHANGES verdicts on pull
 * requests the operator authored (GitHub forbids self-verdicts).
 * Worker code must not import this module (see GitHubBindingsWorker.ts).
 */
import * as Auth from "alchemy/Auth";
import * as GitHub from "alchemy/GitHub";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { testAlchemy } from "../Repos.ts";

/**
 * The AuthProviders registry, WITH GitHub registered. `fresh` matters:
 * the registration layer is memoized by REFERENCE, and at plan time the
 * CLI's own graph already built it against the CLI's registry — without
 * `fresh`, ours would stay empty.
 */
const AuthRegistry = Layer.fresh(GitHub.Auth.GitHubAuth).pipe(
  Layer.provideMerge(Layer.succeed(Auth.AuthProviders, {})),
);

const ProfileCredentials = GitHub.fromAuthProvider().pipe(
  Layer.provide(AuthRegistry),
  Layer.provide(Auth.ProfileLive),
  Layer.provide(Auth.CredentialsStoreLive),
);

export const Credentials = Layer.unwrap(
  Effect.gen(function* () {
    const appId = yield* Config.string("GITHUB_APP_ID").pipe(
      Config.withDefault(""),
    );
    const privateKey = yield* Config.redacted("GITHUB_APP_PRIVATE_KEY").pipe(
      Config.withDefault(undefined),
    );
    if (appId !== "" && privateKey !== undefined) {
      return GitHub.fromApp({
        appId,
        privateKey,
        repository: yield* GitHub.resolveRepository(testAlchemy),
      });
    }
    return ProfileCredentials;
  }),
);

export const GitHubLocal = Layer.mergeAll(
  GitHub.CreateIssueCommentLocal,
  GitHub.CreatePullRequestLocal,
  GitHub.CreatePullRequestReviewLocal,
  GitHub.GetIssueLocal,
  GitHub.GetPullRequestLocal,
  GitHub.ListIssuesLocal,
  GitHub.ListPullRequestReviewsLocal,
  GitHub.ListPullRequestsLocal,
  GitHub.MergePullRequestLocal,
  GitHub.SearchIssuesLocal,
  GitHub.UpdateIssueLocal,
).pipe(Layer.provideMerge(Credentials));
