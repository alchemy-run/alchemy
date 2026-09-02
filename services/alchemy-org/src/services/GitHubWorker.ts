import {
  CreateIssueCommentHttp,
  CreatePullRequestHttp,
  CreatePullRequestReviewHttp,
  GetIssueHttp,
  GetPullRequestHttp,
  ListIssueCommentsHttp,
  ListPullRequestReviewCommentsHttp,
  ListPullRequestReviewsHttp,
  ListPullRequestsHttp,
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
  CreateIssueCommentHttp,
  CreatePullRequestHttp,
  CreatePullRequestReviewHttp,
  GetIssueHttp,
  GetPullRequestHttp,
  // the pull-request SURFACE (Routes.ts): conversation, verdicts, and
  // inline comments, read for the operator's review page
  ListIssueCommentsHttp,
  ListPullRequestReviewCommentsHttp,
  ListPullRequestReviewsHttp,
  ListPullRequestsHttp,
);
