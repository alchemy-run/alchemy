import * as Issues from "@distilled.cloud/github/issues";
import * as Pulls from "@distilled.cloud/github/pulls";
import * as Repos from "@distilled.cloud/github/repos";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { dedent } from "../Util/dedent.ts";
import {
  effectiveGitHubBaseUrl,
  gitHubBaseUrlChanged,
  githubFor,
} from "./Client.ts";
import { GitHubCredentials } from "./Credentials.ts";
import type * as GitHub from "./Providers.ts";

export interface PullRequestProps {
  /**
   * Repository owner (user or organization).
   */
  owner: string;

  /**
   * Repository name.
   */
  repository: string;

  /**
   * Pull request title.
   */
  title: string;

  /**
   * Pull request body (supports GitHub Markdown).
   *
   * The body is automatically dedented, so you can use indented template
   * literals without worrying about leading whitespace. Accepts
   * `Output<string>` at the call site via `Output.interpolate` to embed
   * resource attributes that are not yet resolved.
   */
  body?: string;

  /**
   * The name of the branch where your changes are implemented (the source).
   */
  head: string;

  /**
   * The name of the branch you want the changes pulled into (the target).
   */
  base: string;

  /**
   * State of the pull request. Use "open" to reopen a closed PR or "closed"
   * to close an open PR. Note: only the PR owner, repo owner, or user with
   * push access can close PRs.
   * @default "open"
   */
  state?: "open" | "closed";

  /**
   * Whether the pull request is a draft.
   * @default false
   */
  draft?: boolean;

  /**
   * Labels to attach to the pull request. The provided list fully replaces
   * any existing labels.
   */
  labels?: string[];

  /**
   * Assignees (user logins) to assign to the pull request. The provided list
   * fully replaces existing assignees.
   */
  assignees?: string[];

  /**
   * Reviewers (user logins) to request reviews from. The provided list fully
   * replaces existing review requests.
   */
  reviewers?: string[];

  /**
   * Team slugs (for organization repos) to request reviews from.
   */
  teamReviewers?: string[];

  /**
   * Milestone number to assign to the pull request. Use `null` to remove
   * milestone.
   */
  milestone?: number | null;

  /**
   * Whether maintainers of the base repository can modify the pull
   * request's head branch. This does not change the pull request author.
   */
  maintainerCanModify?: boolean;

  /**
   * Override the GitHub host or API base URL for this resource only (e.g.
   * `github.example.com` for GitHub Enterprise). Falls back to
   * `GitHub.providers({ baseUrl })`, then to the host resolved by the auth
   * provider. Changing it replaces the resource — the same name on a
   * different GitHub instance is a different physical resource.
   */
  baseUrl?: string;
}

export interface PullRequest extends Resource<
  "GitHub.PullRequest",
  PullRequestProps,
  {
    /**
     * The numeric ID of the pull request in GitHub.
     */
    prNumber: number;

    /**
     * GraphQL node ID of the pull request.
     */
    nodeId: string;

    /**
     * URL to view the pull request in a browser.
     */
    htmlUrl: string;

    /**
     * State of the pull request (open or closed).
     */
    state: "open" | "closed";

    /**
     * Whether the pull request is merged.
     */
    merged: boolean;

    /**
     * Whether the pull request is a draft.
     */
    draft: boolean;

    /**
     * ISO-8601 timestamp of when the pull request was created.
     */
    createdAt: string;

    /**
     * ISO-8601 timestamp of the last update.
     */
    updatedAt: string;
  },
  never,
  GitHub.Providers
> {}

/**
 * A GitHub pull request.
 *
 * `PullRequest` manages the lifecycle of a pull request in a repository. PRs
 * are created on the first deploy and updated in place on subsequent deploys
 * when properties change. By default, pull requests are retained on
 * destruction to preserve history — set `destroy()` to opt in to closure.
 *
 * Authentication is resolved via the `GitHubCredentials` service supplied by
 * `GitHub.providers()` (env, stored PAT, `gh` CLI, or OAuth). The token needs
 * `repo` scope for private repositories or `public_repo` for public ones.
 *
 * ### Creating Pull Requests
 * **Example:** Create a Basic Pull Request
 * ```typescript
 * const pr = yield* GitHub.PullRequest("feature-pr", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   title: "Add new feature",
 *   body: "## Changes\n\nThis PR adds...",
 *   head: "feature-branch",
 *   base: "main",
 * })
 * ```
 *
 * **Example:** Draft Pull Request with Reviewers
 * ```typescript
 * const pr = yield* GitHub.PullRequest("draft-pr", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   title: "WIP: New feature",
 *   body: "Work in progress...",
 *   head: "feature-branch",
 *   base: "main",
 *   draft: true,
 *   reviewers: ["reviewer1", "reviewer2"],
 *   teamReviewers: ["platform-team"],
 * })
 * ```
 *
 * ### Updating Pull Requests
 * Deploy with the same logical ID and different properties to update the
 * existing PR in place rather than creating a new one.
 *
 * **Example:** Update PR State
 * ```typescript
 * const pr = yield* GitHub.PullRequest("completed-pr", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   title: "Add new feature",
 *   body: "Completed and ready to merge.",
 *   head: "feature-branch",
 *   base: "main",
 *   state: "closed",
 * })
 * ```
 *
 * ### Pull Request with Labels and Milestone
 * **Example:** Organized Pull Request
 * ```typescript
 * const pr = yield* GitHub.PullRequest("release-pr", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   title: "Release v1.0",
 *   body: "Release notes...",
 *   head: "release-1.0",
 *   base: "main",
 *   labels: ["release", "v1.0"],
 *   milestone: 1,
 * })
 * ```
 *
 * ### Infrastructure Deployment PRs
 * A common pattern is creating PRs for infrastructure changes that require
 * review before merging.
 *
 * **Example:** Infrastructure Change PR
 * ```typescript
 * yield* GitHub.PullRequest("infra-update", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   title: "Update infrastructure configuration",
 *   body: Output.interpolate`
 *     ## Infrastructure Changes
 *
 *     **Database:** ${database.endpoint}
 *     **Cache:** ${cache.endpoint}
 *
 *     Requires approval before deployment.
 *   `,
 *   head: "infra-updates",
 *   base: "main",
 *   labels: ["infrastructure"],
 *   reviewers: ["infrastructure-lead"],
 * })
 * ```
 *
 * @resource
 */
export const PullRequest = Resource<PullRequest>("GitHub.PullRequest", {
  defaultRemovalPolicy: "retain",
});

export const PullRequestProvider = () =>
  Provider.succeed(PullRequest, {
    stables: ["prNumber", "nodeId"],

    // A PR belongs to (host, owner, repository, head, base) — changing any
    // of these replaces the resource: a fresh PR is created with the new
    // configuration, and the old one is retained by default.
    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news)) return;
      if (olds === undefined) return;
      if (
        news.owner !== olds.owner ||
        news.repository !== olds.repository ||
        news.head !== olds.head ||
        news.base !== olds.base ||
        (yield* gitHubBaseUrlChanged(olds, news))
      ) {
        return { action: "replace" };
      }
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const github = yield* githubFor(news.baseUrl);
      const scope = { owner: news.owner, repo: news.repository };
      const body = news.body === undefined ? undefined : dedent(news.body);
      const findOpen = () =>
        Pulls.list({
          ...scope,
          head: news.head.includes(":")
            ? news.head
            : `${news.owner}:${news.head}`,
          base: news.base,
          state: "open",
          per_page: 100,
        }).pipe(
          github,
          Effect.map((pulls) => pulls[0]?.number),
        );
      let number = output?.prNumber;
      let observed =
        number === undefined ? undefined : yield* getPull(news, number);
      if (observed === undefined) {
        number = yield* findOpen();
        if (number === undefined) {
          number = yield* Pulls.create({
            ...scope,
            title: news.title,
            body,
            head: news.head,
            base: news.base,
            draft: news.draft,
            maintainer_can_modify: news.maintainerCanModify,
          }).pipe(
            github,
            Effect.map((data) => data.number),
            Effect.catchTag("UnprocessableEntity", (error) =>
              findOpen().pipe(
                Effect.flatMap((existing) =>
                  existing === undefined
                    ? Effect.fail(error)
                    : Effect.succeed(existing),
                ),
              ),
            ),
          );
        }
        observed = yield* getPull(news, number);
      }
      if (observed === undefined) {
        return yield* Effect.fail(
          new Error("Pull request disappeared during reconciliation"),
        );
      }
      const state = news.state ?? "open";
      const draft = news.draft ?? false;
      const draftChanged = draft !== (observed.draft ?? false);
      const syncState = draftChanged ? "open" : state;
      if (
        observed.title !== news.title ||
        (body !== undefined && (observed.body ?? "") !== body) ||
        observed.state !== syncState ||
        (news.maintainerCanModify !== undefined &&
          observed.maintainer_can_modify !== news.maintainerCanModify)
      ) {
        yield* Pulls.update({
          ...scope,
          pull_number: observed.number,
          title: news.title,
          body,
          state: syncState,
          maintainer_can_modify: news.maintainerCanModify,
        }).pipe(github);
      }
      // GitHub only permits draft transitions while a pull request is open.
      if (draftChanged) {
        yield* toggleDraft(news, observed.node_id, draft);
      }
      yield* syncPullRequestMeta(news, observed.number);
      if (draftChanged && state === "closed") {
        yield* Pulls.update({
          ...scope,
          pull_number: observed.number,
          state: "closed",
        }).pipe(github);
      }
      const final = yield* getPull(news, observed.number);
      if (final === undefined) {
        return yield* Effect.fail(
          new Error("Pull request disappeared after reconciliation"),
        );
      }
      return attributes(final);
    }),

    // Enumerate every pull request across the repositories the token can see.
    // NOTE: distilled's pulls.list types only UnprocessableEntity, so the
    // per-repo 403/404 tolerance the Octokit version had cannot be expressed
    // without loosening types — it needs Forbidden/NotFound patched into the
    // operation's error union.
    list: Effect.fn(function* () {
      const github = yield* githubFor();
      const repos = yield* Repos.listForAuthenticatedUser
        .items({ per_page: 100 })
        .pipe(Stream.runCollect, github);

      const perRepo = yield* Effect.forEach(
        repos,
        (repo) =>
          Pulls.list
            .items({
              owner: repo.owner.login,
              repo: repo.name,
              state: "all",
              per_page: 100,
            })
            .pipe(
              Stream.runCollect,
              github,
              Effect.map((pulls) =>
                pulls.map((pr) => ({
                  prNumber: pr.number,
                  nodeId: pr.node_id,
                  htmlUrl: pr.html_url,
                  state: pr.state as "open" | "closed",
                  merged: pr.merged_at !== null,
                  draft: pr.draft ?? false,
                  createdAt: pr.created_at,
                  updatedAt: pr.updated_at,
                })),
              ),
            ),
        { concurrency: 10 },
      );

      return perRepo.flat();
    }),

    delete: Effect.fn(function* ({ olds, output }) {
      // GitHub preserves pull request history; destruction closes it.
      // getPull already tolerates a vanished PR (NotFound → undefined).
      const observed = yield* getPull(olds, output.prNumber);
      if (observed?.state === "open") {
        const github = yield* githubFor(olds.baseUrl);
        yield* Pulls.update({
          owner: olds.owner,
          repo: olds.repository,
          pull_number: output.prNumber,
          state: "closed",
        }).pipe(github);
      }
    }),
  });

const getPull = Effect.fn(function* (props: PullRequestProps, number: number) {
  const github = yield* githubFor(props.baseUrl);
  return yield* Pulls.get({
    owner: props.owner,
    repo: props.repository,
    pull_number: number,
  }).pipe(
    github,
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );
});

const attributes = (data: Pulls.PullRequest) => ({
  prNumber: data.number,
  nodeId: data.node_id,
  htmlUrl: data.html_url,
  state: data.state,
  merged: data.merged,
  draft: data.draft ?? false,
  createdAt: data.created_at,
  updatedAt: data.updated_at,
});

// Draft transitions have no REST surface (pulls.update takes no `draft`
// member) and distilled ships no GraphQL client, so the two GraphQL
// mutations are issued directly over HttpClient with the same credentials
// the REST operations use.
const toggleDraft = Effect.fn(function* (
  props: PullRequestProps,
  nodeId: string,
  draft: boolean,
) {
  const creds = yield* yield* GitHubCredentials;
  const apiBaseUrl =
    (yield* effectiveGitHubBaseUrl(props.baseUrl)) ?? "https://api.github.com";
  // GHES REST lives at {host}/api/v3 while GraphQL is at {host}/api/graphql;
  // github.com and GHE data residency append /graphql to the API host.
  const endpoint = apiBaseUrl.endsWith("/api/v3")
    ? apiBaseUrl.replace(/\/api\/v3$/, "/api/graphql")
    : `${apiBaseUrl.replace(/\/+$/, "")}/graphql`;
  const mutation = draft
    ? "convertPullRequestToDraft"
    : "markPullRequestReadyForReview";
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.execute(
    HttpClientRequest.post(endpoint).pipe(
      HttpClientRequest.bearerToken(Redacted.value(creds.token)),
      HttpClientRequest.setHeaders({
        Accept: "application/json",
        "User-Agent": "Alchemy (alchemy.run)",
      }),
      HttpClientRequest.bodyJsonUnsafe({
        query: `mutation($id: ID!) { ${mutation}(input: {pullRequestId: $id}) { pullRequest { id } } }`,
        variables: { id: nodeId },
      }),
    ),
  );
  const payload = (yield* response.json) as {
    errors?: ReadonlyArray<{ message?: string }>;
  };
  if (response.status !== 200 || (payload.errors?.length ?? 0) > 0) {
    return yield* Effect.fail(
      new Error(
        `GitHub GraphQL ${mutation} failed: ${
          payload.errors?.map((e) => e.message).join("; ") ??
          `HTTP ${response.status}`
        }`,
      ),
    );
  }
});

const sameNames = (left: string[], right: string[]) =>
  JSON.stringify([...new Set(left)].sort()) ===
  JSON.stringify([...new Set(right)].sort());

const syncPullRequestMeta = Effect.fn(function* (
  props: PullRequestProps,
  prNumber: number,
) {
  const github = yield* githubFor(props.baseUrl);
  const scope = { owner: props.owner, repo: props.repository };
  const issue = { ...scope, issue_number: prNumber };
  const data = yield* Issues.get(issue).pipe(github);
  const labels = data.labels.map((label) =>
    typeof label === "string" ? label : (label.name ?? ""),
  );
  if (props.labels !== undefined && !sameNames(labels, props.labels)) {
    yield* Issues.setLabels({
      ...issue,
      body: { labels: props.labels },
    }).pipe(github);
  }
  const assignees = data.assignees?.map((user) => user.login) ?? [];
  if (props.assignees !== undefined && !sameNames(assignees, props.assignees)) {
    yield* Issues.update({ ...issue, assignees: props.assignees }).pipe(github);
  }
  if (
    props.milestone !== undefined &&
    (data.milestone?.number ?? null) !== props.milestone
  ) {
    yield* Issues.update({ ...issue, milestone: props.milestone }).pipe(github);
  }
  if (props.reviewers !== undefined || props.teamReviewers !== undefined) {
    const pull = { ...scope, pull_number: prNumber };
    const current = yield* Pulls.listRequestedReviewers(pull).pipe(github);
    const users = current.users.map((user) => user.login);
    const teams = current.teams.map((team) => team.slug);
    const removeUsers =
      props.reviewers === undefined
        ? []
        : users.filter((user) => !props.reviewers!.includes(user));
    const removeTeams =
      props.teamReviewers === undefined
        ? []
        : teams.filter((team) => !props.teamReviewers!.includes(team));
    if (removeUsers.length || removeTeams.length) {
      yield* Pulls.removeRequestedReviewers({
        ...pull,
        reviewers: removeUsers,
        team_reviewers: removeTeams,
      }).pipe(github);
    }
    const addUsers = (props.reviewers ?? []).filter(
      (user) => !users.includes(user),
    );
    const addTeams = (props.teamReviewers ?? []).filter(
      (team) => !teams.includes(team),
    );
    if (addUsers.length || addTeams.length) {
      yield* Pulls.requestReviewers({
        ...pull,
        reviewers: addUsers,
        team_reviewers: addTeams,
      }).pipe(github);
    }
  }
});
