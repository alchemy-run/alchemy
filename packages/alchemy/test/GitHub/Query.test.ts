import * as GitHub from "@/GitHub";
import { Octokit } from "@/GitHub/Octokit";
import { destroy } from "@/RemovalPolicy";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  deleteBranches,
  fixture,
  owner,
  prepareBranches,
  providers,
  repoName,
  request,
} from "./fixtures/pull-request.ts";

const { test } = Test.make({ providers });
const repo = "alchemy-pr-1569-query";

test.provider(
  "query and get fixture pull requests with state and branch filters",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      yield* stack.deploy(fixture(repo));
      const base = yield* prepareBranches(repo);
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const repository = yield* fixture(repo);
          return yield* GitHub.PullRequest("PR", {
            owner,
            repository: repoName(repository),
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

      yield* stack.deploy(fixture(repo));
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
      yield* deleteBranches(repo);
      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);
