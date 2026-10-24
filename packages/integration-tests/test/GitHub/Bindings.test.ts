import * as Cloudflare from "@alchemy.run/cloudflare";
import * as GitHub from "@alchemy.run/github";
import { Octokit as AmbientOctokit } from "@alchemy.run/github/Octokit";
import { describe, expect } from "@alchemy.run/test";
import * as Alchemy from "alchemy";
import { Action } from "alchemy/Action";
import * as Test from "alchemy/Test/Alchemy";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";
import GitHubBindingsWorker, { owner, Repo, repository } from "./fixtures/bindings-worker.ts";

const providers = Layer.mergeAll(Cloudflare.providers(), GitHub.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({ providers });

// Out-of-band verification with the provider's credentials.
const Octokit = AmbientOctokit.pipe(Effect.provide(GitHub.providers()));

const Stack = Alchemy.Stack(
  "GitHubBindingsStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    yield* Repo;
    const worker = yield* GitHubBindingsWorker;
    return { url: worker.url.as<string>() };
  }),
);

const stack = beforeAll(deploy(Stack), { timeout: 300_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 300_000 });

const stage = Test.defaultStage();
const scope = { owner, repo: repository };
const tags = [
  "provider:cloudflare",
  "provider:cloudflare:worker",
  "provider:github",
  "provider:github:bindings",
  "live",
];

type Answer<A> = { data: A; error?: undefined } | { data?: undefined; error: { _tag: string } };

/** Call a binding on the deployed Worker: `POST /<Binding>` with the request as JSON. */
const call = <A = any>(binding: string, request: unknown) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    const response = yield* Test.executeWhenReady(
      HttpClientRequest.post(`${url.replace(/\/+$/, "")}/${binding}`).pipe(
        HttpClientRequest.bodyJsonUnsafe(request ?? {}),
      ),
    );
    expect(response.status).toBe(200);
    return (yield* response.json) as unknown as Answer<A>;
  });

/** Call a binding and fail the test unless it answered with data. */
const ok = <A = any>(binding: string, request?: unknown) =>
  call<A>(binding, request).pipe(
    Effect.map((answer) => {
      expect(answer.error).toBeUndefined();
      return answer.data as A;
    }),
  );

const request = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (error) => error as Error & { status?: number },
  });

class NotYet extends Data.TaggedError("NotYet")<{}> {}

// Issue lists and search lag writes; bounded so a real failure surfaces.
const indexed = { schedule: Schedule.spaced("5 seconds"), times: 18 };

const title = `alchemy bindings ${stage} ${crypto.randomUUID()}`;
let issueNumber: number | undefined;

// Close the run's issue even when a test failed before UpdateIssue did.
afterAll(
  Effect.gen(function* () {
    if (issueNumber === undefined) return;
    const octokit = yield* Octokit;
    yield* request(() =>
      octokit.rest.issues.update({ ...scope, issue_number: issueNumber!, state: "closed" }),
    );
  }),
);

// A head branch with one commit, merged into a throwaway base branch so the
// repository's default branch never changes.
const base = `alchemy-bindings-${stage}-base`;
const head = `alchemy-bindings-${stage}-head`;
const path = `alchemy-bindings/${stage}.txt`;
let pullNumber: number;

const resetBranches = Effect.gen(function* () {
  const octokit = yield* Octokit;
  const { data: repo } = yield* request(() => octokit.rest.repos.get(scope));
  const { data: main } = yield* request(() =>
    octokit.rest.git.getRef({ ...scope, ref: `heads/${repo.default_branch}` }),
  );
  for (const branch of [base, head]) {
    yield* request(() => octokit.rest.git.deleteRef({ ...scope, ref: `heads/${branch}` })).pipe(
      Effect.catchIf(
        (error) => error.status === 404 || error.status === 422,
        () => Effect.void,
      ),
    );
    yield* request(() =>
      octokit.rest.git.createRef({
        ...scope,
        ref: `refs/heads/${branch}`,
        sha: main.object.sha,
      }),
    );
  }
  const existing = yield* request(() =>
    octokit.rest.repos.getContent({ ...scope, path, ref: head }),
  ).pipe(
    Effect.map(({ data }) => (Array.isArray(data) ? undefined : data.sha)),
    Effect.catchIf(
      (error) => error.status === 404,
      () => Effect.succeed(undefined),
    ),
  );
  yield* request(() =>
    octokit.rest.repos.createOrUpdateFileContents({
      ...scope,
      branch: head,
      path,
      message: "test: GitHub runtime bindings",
      content: Buffer.from(`line one\n${crypto.randomUUID()}\n`).toString("base64"),
      sha: existing,
    }),
  );
});

const deleteBranches = Effect.gen(function* () {
  const octokit = yield* Octokit;
  for (const branch of [head, base]) {
    yield* request(() => octokit.rest.git.deleteRef({ ...scope, ref: `heads/${branch}` })).pipe(
      Effect.catchIf(
        (error) => error.status === 404 || error.status === 422,
        () => Effect.void,
      ),
    );
  }
});

afterAll(deleteBranches);

describe.sequential("GitHub runtime bindings", () => {
  describe("CreateIssue", () => {
    test(
      "opens an issue in the bound repository",
      Effect.gen(function* () {
        const issue = yield* ok("CreateIssue", { title, body: "created by CreateIssue" });
        issueNumber = issue.number;
        expect(issue.title).toBe(title);

        const octokit = yield* Octokit;
        const { data } = yield* request(() =>
          octokit.rest.issues.get({ ...scope, issue_number: issueNumber! }),
        );
        expect(data.title).toBe(title);
        expect(data.body).toBe("created by CreateIssue");
      }),
      { tags, timeout: 180_000 },
    );
  });

  describe("GetIssue", () => {
    test(
      "gets an issue by number",
      Effect.gen(function* () {
        const issue = yield* ok("GetIssue", { issue_number: issueNumber });
        expect(issue.number).toBe(issueNumber);
        expect(issue.title).toBe(title);
      }),
      { tags },
    );

    test(
      "fails with IssueNotFound for a missing issue",
      Effect.gen(function* () {
        const answer = yield* call("GetIssue", { issue_number: 999_999_999 });
        expect(answer.error?._tag).toBe("IssueNotFound");
      }),
      { tags },
    );
  });

  describe("ListIssues", () => {
    test(
      "lists the repository's issues",
      Effect.gen(function* () {
        const issues = yield* ok<{ number: number }[]>("ListIssues", {
          state: "open",
          sort: "created",
          direction: "desc",
          per_page: 100,
        }).pipe(
          // The list lags writes like search does.
          Effect.filterOrFail(
            (issues) => issues.some((issue) => issue.number === issueNumber),
            () => new NotYet(),
          ),
          Effect.retry({ while: (error) => Predicate.isTagged(error, "NotYet"), ...indexed }),
        );
        expect(issues.map((issue) => issue.number)).toContain(issueNumber);
      }),
      { tags, timeout: 150_000 },
    );
  });

  describe("SearchIssues", () => {
    test(
      "searches issues scoped to the bound repository",
      Effect.gen(function* () {
        const result = yield* ok<{ items: { number: number }[] }>("SearchIssues", {
          q: `"${title}" in:title`,
        }).pipe(
          Effect.filterOrFail(
            (result) => result.items.some((item) => item.number === issueNumber),
            () => new NotYet(),
          ),
          Effect.retry({ while: (error) => Predicate.isTagged(error, "NotYet"), ...indexed }),
        );
        expect(result.items.map((item) => item.number)).toEqual([issueNumber]);
      }),
      { tags, timeout: 150_000 },
    );
  });

  describe("CreateIssueComment", () => {
    test(
      "comments on an issue",
      Effect.gen(function* () {
        const comment = yield* ok("CreateIssueComment", {
          issue_number: issueNumber!,
          body: "comment from CreateIssueComment",
        });
        const octokit = yield* Octokit;
        const { data } = yield* request(() =>
          octokit.rest.issues.getComment({ ...scope, comment_id: comment.id }),
        );
        expect(data.body).toBe("comment from CreateIssueComment");
      }),
      { tags },
    );
  });

  describe("ListIssueComments", () => {
    test(
      "lists an issue's comments",
      Effect.gen(function* () {
        const comments = yield* ok<{ body: string }[]>("ListIssueComments", {
          issue_number: issueNumber!,
        });
        expect(comments.map((comment) => comment.body)).toEqual([
          "comment from CreateIssueComment",
        ]);
      }),
      { tags },
    );
  });

  describe("UpdateIssue", () => {
    test(
      "closes an issue",
      Effect.gen(function* () {
        const issue = yield* ok("UpdateIssue", {
          issue_number: issueNumber!,
          body: "updated by UpdateIssue",
          state: "closed",
          state_reason: "completed",
        });
        expect(issue.state).toBe("closed");

        const octokit = yield* Octokit;
        const { data } = yield* request(() =>
          octokit.rest.issues.get({ ...scope, issue_number: issueNumber! }),
        );
        expect(data.state).toBe("closed");
        expect(data.state_reason).toBe("completed");
        expect(data.body).toBe("updated by UpdateIssue");
      }),
      { tags },
    );

    test(
      "fails with IssueNotFound for a missing issue",
      Effect.gen(function* () {
        const answer = yield* call("UpdateIssue", { issue_number: 999_999_999, title: "x" });
        expect(answer.error?._tag).toBe("IssueNotFound");
      }),
      { tags },
    );
  });

  describe("Local layers", () => {
    test.provider(
      "GetIssueLocal reads an issue from an Action with the current credentials",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const out = yield* stack.deploy(
            Effect.gen(function* () {
              const repo = yield* Repo;
              const ReadIssue = Action(
                "ReadIssue",
                Effect.gen(function* () {
                  const getIssue = yield* GitHub.GetIssue(repo);
                  return Effect.fn(function* (input: { issueNumber: number }) {
                    const issue = yield* getIssue({ issue_number: input.issueNumber }).pipe(
                      Effect.orDie,
                    );
                    return { title: issue.title, state: issue.state };
                  });
                }).pipe(Effect.provide(GitHub.GetIssueLocal)),
              );
              return yield* ReadIssue({ issueNumber: issueNumber! });
            }),
          );
          expect(out).toEqual({ title, state: "closed" });
          yield* stack.destroy();
        }),
      { tags, timeout: 120_000 },
    );
  });

  describe("CreatePullRequest", () => {
    test(
      "opens a pull request",
      Effect.gen(function* () {
        yield* resetBranches;
        const pull = yield* ok("CreatePullRequest", {
          title: `alchemy bindings ${stage}`,
          head,
          base,
          body: "opened by CreatePullRequest",
        });
        pullNumber = pull.number;

        const octokit = yield* Octokit;
        const { data } = yield* request(() =>
          octokit.rest.pulls.get({ ...scope, pull_number: pullNumber }),
        );
        expect(data.state).toBe("open");
        expect(data.head.ref).toBe(head);
        expect(data.base.ref).toBe(base);
      }),
      { tags, timeout: 120_000 },
    );
  });

  describe("GetPullRequest", () => {
    test(
      "gets a pull request as JSON",
      Effect.gen(function* () {
        const pull = yield* ok("GetPullRequest", { pull_number: pullNumber });
        expect(pull.number).toBe(pullNumber);
        expect(pull.head.ref).toBe(head);
      }),
      { tags },
    );

    test(
      "gets a pull request's diff as text",
      Effect.gen(function* () {
        const diff = yield* ok<string>("GetPullRequest", {
          pull_number: pullNumber,
          format: "diff",
        });
        expect(diff).toContain(`diff --git a/${path} b/${path}`);
      }),
      { tags },
    );
  });

  describe("ListPullRequests", () => {
    test(
      "lists the repository's pull requests",
      Effect.gen(function* () {
        const pulls = yield* ok<{ number: number }[]>("ListPullRequests", {
          state: "open",
          base,
        });
        expect(pulls.map((pull) => pull.number)).toEqual([pullNumber]);
      }),
      { tags },
    );
  });

  describe("ListPullRequestFiles", () => {
    test(
      "lists the files a pull request changes",
      Effect.gen(function* () {
        const files = yield* ok<{ filename: string; status: string }[]>("ListPullRequestFiles", {
          pull_number: pullNumber,
        });
        expect(files.map((file) => file.filename)).toEqual([path]);
      }),
      { tags },
    );
  });

  let reviewId: number;

  describe("CreatePullRequestReview", () => {
    test(
      "submits a review with an inline comment",
      Effect.gen(function* () {
        const review = yield* ok("CreatePullRequestReview", {
          pull_number: pullNumber,
          event: "COMMENT",
          body: "review from CreatePullRequestReview",
          comments: [{ path, line: 1, body: "inline comment" }],
        });
        reviewId = review.id;

        const octokit = yield* Octokit;
        const { data } = yield* request(() =>
          octokit.rest.pulls.getReview({ ...scope, pull_number: pullNumber, review_id: reviewId }),
        );
        expect(data.body).toBe("review from CreatePullRequestReview");
        expect(data.state).toBe("COMMENTED");
      }),
      { tags },
    );
  });

  describe("ListPullRequestReviews", () => {
    test(
      "lists a pull request's reviews",
      Effect.gen(function* () {
        const reviews = yield* ok<{ id: number }[]>("ListPullRequestReviews", {
          pull_number: pullNumber,
        });
        expect(reviews.map((review) => review.id)).toEqual([reviewId]);
      }),
      { tags },
    );
  });

  describe("ListPullRequestReviewComments", () => {
    test(
      "lists a pull request's inline review comments",
      Effect.gen(function* () {
        const comments = yield* ok<
          { body: string; path: string; pull_request_review_id: number }[]
        >("ListPullRequestReviewComments", { pull_number: pullNumber });
        expect(
          comments.map(({ body, path, pull_request_review_id }) => ({
            body,
            path,
            pull_request_review_id,
          })),
        ).toEqual([{ body: "inline comment", path, pull_request_review_id: reviewId }]);
      }),
      { tags },
    );
  });

  describe("MergePullRequest", () => {
    test(
      "merges a pull request",
      Effect.gen(function* () {
        const merged = yield* ok("MergePullRequest", {
          pull_number: pullNumber,
          merge_method: "squash",
        });
        expect(merged.merged).toBe(true);

        const octokit = yield* Octokit;
        const { data } = yield* request(() =>
          octokit.rest.pulls.get({ ...scope, pull_number: pullNumber }),
        );
        expect(data.merged).toBe(true);
        expect(data.base.ref).toBe(base);
      }),
      { tags },
    );
  });
});
