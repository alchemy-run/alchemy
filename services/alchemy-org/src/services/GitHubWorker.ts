import {
  CreateIssueCommentHttp,
  CreatePullRequestReviewHttp,
  GetIssueHttp,
  GetPullRequestHttp,
  ListPullRequestsHttp,
} from "alchemy/GitHub";
import * as Layer from "effect/Layer";

/**
 * GitHub HTTP bindings for the Cloudflare Worker — token-scoped
 * `*Http` layers only (each mints/binds a PersonalAccessToken at plan
 * time; at runtime the bound token answers). Named imports (not
 * `import *`) so the Worker bundler can tree-shake Auth/profile/
 * Providers out of `alchemy/GitHub`. The mirror of GitHubLocal.ts.
 */
export const GitHubWorker = Layer.mergeAll(
  CreateIssueCommentHttp,
  CreatePullRequestReviewHttp,
  GetIssueHttp,
  GetPullRequestHttp,
  ListPullRequestsHttp,
);
