import {
  CreateIssueCommentHttp,
  CreatePullRequestHttp,
  CreatePullRequestReviewHttp,
  GetIssueHttp,
  GetPullRequestHttp,
  ListIssueCommentsHttp,
  ListPullRequestFilesHttp,
  ListPullRequestReviewCommentsHttp,
  ListPullRequestReviewsHttp,
  ListPullRequestsHttp,
  MergePullRequestHttp,
} from "alchemy/GitHub";
import * as Layer from "effect/Layer";

/**
 * GitHub HTTP bindings for the Cloudflare Worker — token-scoped
 * `*Http` layers only (each mints/binds a PersonalAccessToken at plan
 * time; at runtime the bound token answers). Named imports (not
 * `import *`) so the Worker bundler can tree-shake Auth/profile/
 * Providers out of `alchemy/GitHub`.
 */
export const GitHubWorker = Layer.mergeAll(
  // the WRITES — reached only by the proposal executor (Routes.ts), on
  // the operator's accept; no agent tool holds them
  CreateIssueCommentHttp,
  CreatePullRequestHttp,
  CreatePullRequestReviewHttp,
  MergePullRequestHttp,
  GetIssueHttp,
  GetPullRequestHttp,
  // the pull-request SURFACE (Routes.ts): conversation, verdicts, and
  // inline comments, read for the operator's review page — and the
  // files, paged, for its diff (and the Reviewer's, when GitHub refuses
  // to serve a big PR's diff whole)
  ListIssueCommentsHttp,
  ListPullRequestFilesHttp,
  ListPullRequestReviewCommentsHttp,
  ListPullRequestReviewsHttp,
  ListPullRequestsHttp,
);
