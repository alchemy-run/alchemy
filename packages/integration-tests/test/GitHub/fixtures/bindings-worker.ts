import * as Cloudflare from "@alchemy.run/cloudflare";
import * as GitHub from "@alchemy.run/github";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

export const owner = "alchemy-run-test";
export const repository = "alchemy-pr-1932-event-source";

// Public and retained across runs: the gh token lacks delete_repo.
export const Repo = GitHub.Repository("Repo", {
  owner,
  name: repository,
  visibility: "public",
  autoInit: true,
});

// `POST /<Binding>` calls the binding with the JSON body as its request.
// Failures answer 200 with `{ error }` so the test can assert typed tags.
export default class GitHubBindingsWorker extends Cloudflare.Worker<GitHubBindingsWorker>()(
  "GitHubBindingsWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const repo = yield* Repo;
    const bindings: Record<
      string,
      (request: any) => Effect.Effect<unknown, { _tag: string }, RuntimeContext>
    > = {
      CreateIssue: yield* GitHub.CreateIssue(repo),
      GetIssue: yield* GitHub.GetIssue(repo),
      UpdateIssue: yield* GitHub.UpdateIssue(repo),
      ListIssues: yield* GitHub.ListIssues(repo),
      SearchIssues: yield* GitHub.SearchIssues(repo),
      CreateIssueComment: yield* GitHub.CreateIssueComment(repo),
      ListIssueComments: yield* GitHub.ListIssueComments(repo),
      GetPullRequest: yield* GitHub.GetPullRequest(repo),
      ListPullRequests: yield* GitHub.ListPullRequests(repo),
      CreatePullRequest: yield* GitHub.CreatePullRequest(repo),
      MergePullRequest: yield* GitHub.MergePullRequest(repo),
      CreatePullRequestReview: yield* GitHub.CreatePullRequestReview(repo),
      ListPullRequestReviews: yield* GitHub.ListPullRequestReviews(repo),
      ListPullRequestReviewComments: yield* GitHub.ListPullRequestReviewComments(repo),
      ListPullRequestFiles: yield* GitHub.ListPullRequestFiles(repo),
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const binding = bindings[new URL(request.url, "http://worker").pathname.slice(1)];
        if (binding === undefined || request.method !== "POST") {
          return HttpServerResponse.text("ok");
        }
        const body = yield* request.json;
        return yield* binding(body).pipe(
          Effect.map((data) => ({ data })),
          Effect.catch((error) => Effect.succeed({ error })),
          Effect.flatMap((result) => HttpServerResponse.json(result)),
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        GitHub.CreateIssueHttp,
        GitHub.GetIssueHttp,
        GitHub.UpdateIssueHttp,
        GitHub.ListIssuesHttp,
        GitHub.SearchIssuesHttp,
        GitHub.CreateIssueCommentHttp,
        GitHub.ListIssueCommentsHttp,
        GitHub.GetPullRequestHttp,
        GitHub.ListPullRequestsHttp,
        GitHub.CreatePullRequestHttp,
        GitHub.MergePullRequestHttp,
        GitHub.CreatePullRequestReviewHttp,
        GitHub.ListPullRequestReviewsHttp,
        GitHub.ListPullRequestReviewCommentsHttp,
        GitHub.ListPullRequestFilesHttp,
      ),
    ),
  ),
) {}
