import * as Effect from "effect/Effect"
import { Octokit } from "./Octokit.ts"

/**
 * Query filters for GitHub Pull Requests.
 */
export interface PullRequestQueryFilters {
  /**
   * Filter by PR state.
   * @default "open"
   */
  state?: "open" | "closed" | "all"

  /**
   * Filter by head branch (source branch).
   */
  head?: string

  /**
   * Filter by base branch (target branch).
   */
  base?: string

  /**
   * Sort field.
   * @default "created"
   */
  sort?: "created" | "updated" | "popularity" | "long-running"

  /**
   * Sort direction.
   * @default "desc"
   */
  direction?: "asc" | "desc"
}

/**
 * Result shape for queried pull requests.
 */
export interface QueriedPullRequest {
  number: number
  nodeId: string
  title: string
  body: string | null
  state: "open" | "closed"
  head: string
  base: string
  draft: boolean
  merged: boolean
  labels: string[]
  assignees: string[]
  reviewers: string[]
  milestone: number | null
  htmlUrl: string
  createdAt: string
  updatedAt: string
  closedAt: string | null
  mergedAt: string | null
}

/**
 * Query pull requests from a repository with optional filters.
 *
 * This is the observation/read side of the GitHub provider, enabling queries
 * against existing PRs without declaring them as managed resources.
 *
 * **Example:** Query Open PRs to Main
 * ```typescript
 * const openPRs = yield* GitHub.queryPullRequests("my-org", "my-repo", {
 *   state: "open",
 *   base: "main",
 * })
 * ```
 *
 * **Example:** Query PRs from Feature Branches
 * ```typescript
 * const featurePRs = yield* GitHub.queryPullRequests("my-org", "my-repo", {
 *   head: "my-org:feature/*",
 *   state: "all",
 * })
 * ```
 */
export const queryPullRequests = (
  owner: string,
  repository: string,
  filters?: PullRequestQueryFilters,
) =>
  Effect.gen(function* () {
    const octokit = yield* Octokit

    const pulls = yield* Effect.tryPromise({
      try: async () => {
        const params: any = {
          owner,
          repo: repository,
          state: filters?.state ?? "open",
          sort: filters?.sort ?? "created",
          direction: filters?.direction ?? "desc",
          per_page: 100,
        }

        if (filters?.head) params.head = filters.head
        if (filters?.base) params.base = filters.base

        return await octokit.paginate(octokit.rest.pulls.list, params)
      },
      catch: (e) => e as Error,
    })

    return yield* Effect.forEach(
      pulls,
      (pr) =>
        Effect.gen(function* () {
          // Fetch reviewers separately
          const reviewData = yield* Effect.tryPromise({
            try: () =>
              octokit.rest.pulls.listRequestedReviewers({
                owner,
                repo: repository,
                pull_number: pr.number,
              }),
            catch: (e) => e as Error,
          })

          const reviewers =
            reviewData.data.users
              ?.map((u) => u.login)
              .filter((login): login is string => login !== undefined) ?? []

          return {
            number: pr.number,
            nodeId: pr.node_id,
            title: pr.title,
            body: pr.body ?? null,
            state: pr.state as "open" | "closed",
            head: pr.head.ref,
            base: pr.base.ref,
            draft: pr.draft ?? false,
            merged: pr.merged ?? false,
            labels: pr.labels
              .map((label) =>
                typeof label === "string" ? label : label.name,
              )
              .filter((name): name is string => name !== undefined),
            assignees:
              pr.assignees
                ?.map((a) => a?.login)
                .filter((login): login is string => login !== undefined) ?? [],
            reviewers,
            milestone: pr.milestone?.number ?? null,
            htmlUrl: pr.html_url,
            createdAt: pr.created_at,
            updatedAt: pr.updated_at,
            closedAt: pr.closed_at ?? null,
            mergedAt: pr.merged_at ?? null,
          } satisfies QueriedPullRequest
        }),
      { concurrency: 5 },
    )
  })

/**
 * Get a single pull request by number.
 *
 * **Example:** Get Specific PR
 * ```typescript
 * const pr = yield* GitHub.getPullRequest("my-org", "my-repo", 456)
 * ```
 */
export const getPullRequest = (
  owner: string,
  repository: string,
  prNumber: number,
) =>
  Effect.gen(function* () {
    const octokit = yield* Octokit

    const { data } = yield* Effect.tryPromise({
      try: () =>
        octokit.rest.pulls.get({
          owner,
          repo: repository,
          pull_number: prNumber,
        }),
      catch: (e) => e as Error,
    })

    // Fetch reviewers separately
    const reviewData = yield* Effect.tryPromise({
      try: () =>
        octokit.rest.pulls.listRequestedReviewers({
          owner,
          repo: repository,
          pull_number: prNumber,
        }),
      catch: (e) => e as Error,
    })

    const reviewers =
      reviewData.data.users
        ?.map((u) => u.login)
        .filter((login): login is string => login !== undefined) ?? []

    return {
      number: data.number,
      nodeId: data.node_id,
      title: data.title,
      body: data.body ?? null,
      state: data.state as "open" | "closed",
      head: data.head.ref,
      base: data.base.ref,
      draft: data.draft ?? false,
      merged: data.merged ?? false,
      labels: data.labels
        .map((label) => (typeof label === "string" ? label : label.name))
        .filter((name): name is string => name !== undefined),
      assignees:
        data.assignees
          ?.map((a) => a?.login)
          .filter((login): login is string => login !== undefined) ?? [],
      reviewers,
      milestone: data.milestone?.number ?? null,
      htmlUrl: data.html_url,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
      closedAt: data.closed_at ?? null,
      mergedAt: data.merged_at ?? null,
    } satisfies QueriedPullRequest
  })
