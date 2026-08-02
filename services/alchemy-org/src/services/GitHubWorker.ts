/**
 * GitHub HTTP bindings for the Cloudflare Worker — token-scoped
 * `*Http` layers only. Named imports (not `import *`) so the Worker
 * bundler can tree-shake Auth/profile/Providers out of `alchemy/GitHub`.
 */
import {
  CreateIssueCommentHttp,
  CreatePullRequestHttp,
  GetIssueHttp,
  GetPullRequestHttp,
  ListIssuesHttp,
  ListPullRequestReviewsHttp,
  ListPullRequestsHttp,
  MergePullRequestHttp,
  SearchIssuesHttp,
  UpdateIssueHttp,
} from "alchemy/GitHub";
import * as Layer from "effect/Layer";

/**
 * The `yield* PersonalAccessToken` inside each `*Http` layer yields
 * the resource CONSTRUCTOR — a requirement the stack satisfies at
 * plan time; it never exists at runtime, where the bound token answers.
 */
export const GitHubWorker = Layer.mergeAll(
  CreateIssueCommentHttp,
  CreatePullRequestHttp,
  GetIssueHttp,
  GetPullRequestHttp,
  ListIssuesHttp,
  ListPullRequestReviewsHttp,
  ListPullRequestsHttp,
  MergePullRequestHttp,
  SearchIssuesHttp,
  UpdateIssueHttp,
);
