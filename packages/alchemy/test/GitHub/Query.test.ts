import * as GitHub from "@/GitHub";
import { Octokit } from "@/GitHub/Octokit.ts";
import * as Output from "@/Output";
import { destroy } from "@/RemovalPolicy";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const owner = process.env.GITHUB_TEST_OWNER ?? "alchemy-run-test";
if (owner !== "alchemy-run-test" && owner !== "alchemy-run-test-2") {
  throw new Error(`Unsafe GITHUB_TEST_OWNER: ${owner}`);
}

const { test } = Test.make({
  providers: GitHub.providers({ baseUrl: "github.com" }),
});

const repo = "alchemy-pr-1569-query";

const repository = () =>
  GitHub.Repository("Repo", {
    owner,
    name: repo,
    description: "Retained deterministic fixture for alchemy PR #1569",
    visibility: "public",
    autoInit: true,
  });

const repoName = (repository: GitHub.Repository) =>
  Output.map(repository.fullName, (fullName) => fullName.split("/")[1]!);

const request = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (error) => error as Error & { status?: number },
  });

const branches = ["alchemy-pr-1569-a", "alchemy-pr-1569-b"];

const prepareBranches = Effect.gen(function* () {
  const client = yield* Octokit;
  const scope = { owner, repo };
  const { data: repository } = yield* request(() =>
    client.rest.repos.get(scope),
  );
  const base = repository.default_branch;
  const { data: ref } = yield* request(() =>
    client.rest.git.getRef({ ...scope, ref: `heads/${base}` }),
  );
  for (const branch of branches) {
    const existing = yield* request(() =>
      client.rest.git.getRef({ ...scope, ref: `heads/${branch}` }),
    ).pipe(
      Effect.catchIf(
        (error) => error.status === 404,
        () => Effect.succeed(undefined),
      ),
    );
    if (existing === undefined) {
      yield* request(() =>
        client.rest.git.createRef({
          ...scope,
          ref: `refs/heads/${branch}`,
          sha: ref.object.sha,
        }),
      );
      yield* request(() =>
        client.rest.repos.createOrUpdateFileContents({
          ...scope,
          branch,
          path: "alchemy-pr-1569.txt",
          message: "Add deterministic PR test fixture",
          content: "YWxjaGVteSBQUiBmaXh0dXJlCg==",
        }),
      );
    }
  }
  return base;
});

const deleteBranches = Effect.gen(function* () {
  const client = yield* Octokit;
  for (const branch of branches) {
    yield* request(() =>
      client.rest.git.deleteRef({ owner, repo, ref: `heads/${branch}` }),
    );
  }
});

test.provider(
  "query and get fixture pull requests with state and branch filters",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      yield* stack.deploy(repository());
      const base = yield* prepareBranches;
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const repo = yield* repository();
          return yield* GitHub.PullRequest("PR", {
            owner,
            repository: repoName(repo),
            head: "alchemy-pr-1569-a",
            base,
            title: "Alchemy PR #1569 query fixture",
            body: "Query fixture body",
            labels: ["bug"],
            draft: true,
          }).pipe(destroy());
        }),
      );

      const pulls = yield* GitHub.queryPullRequests(owner, repo, {
        head: `${owner}:alchemy-pr-1569-a`,
        base,
        sort: "updated",
        direction: "asc",
      });
      expect(pulls).toHaveLength(1);
      const single = yield* GitHub.getPullRequest(
        owner,
        repo,
        created.prNumber,
      );
      expect(pulls[0]).toEqual(single);
      expect(single).toMatchObject({
        number: created.prNumber,
        nodeId: created.nodeId,
        title: "Alchemy PR #1569 query fixture",
        body: "Query fixture body",
        state: "open",
        head: "alchemy-pr-1569-a",
        base,
        draft: true,
        merged: false,
        labels: ["bug"],
        assignees: [],
        reviewers: [],
        milestone: null,
        htmlUrl: `https://github.com/${owner}/${repo}/pull/${created.prNumber}`,
        closedAt: null,
        mergedAt: null,
      });
      expect(single.createdAt).toBeTruthy();
      expect(single.updatedAt).toBeTruthy();
      expect(
        yield* GitHub.queryPullRequests(owner, repo, {
          head: `${owner}:alchemy-pr-1569-b`,
        }),
      ).toEqual([]);

      yield* stack.deploy(repository());
      const client = yield* Octokit;
      const closed = yield* request(() =>
        client.rest.pulls.get({ owner, repo, pull_number: created.prNumber }),
      );
      expect(closed.data.state).toBe("closed");
      expect(yield* GitHub.queryPullRequests(owner, repo)).toEqual([]);
      const closedPulls = yield* GitHub.queryPullRequests(owner, repo, {
        state: "closed",
      });
      const fromList = closedPulls.find(
        (pull) => pull.number === created.prNumber,
      );
      const fromGet = yield* GitHub.getPullRequest(
        owner,
        repo,
        created.prNumber,
      );
      expect(fromList).toEqual(fromGet);
      expect(fromGet.state).toBe("closed");
      expect(fromGet.closedAt).toBeTruthy();
      expect(fromGet.merged).toBe(false);
      const all = yield* GitHub.queryPullRequests(owner, repo, {
        state: "all",
      });
      expect(all.some((pull) => pull.number === created.prNumber)).toBe(true);
      yield* deleteBranches;
      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);
