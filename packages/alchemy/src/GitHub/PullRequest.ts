import * as Effect from "effect/Effect"
import { isResolved } from "../Diff.ts"
import * as Provider from "../Provider.ts"
import { Resource } from "../Resource.ts"
import { dedent } from "../Util/dedent.ts"
import { gitHubBaseUrlChanged, Octokit, octokitFor } from "./Octokit.ts"
import type * as GitHub from "./Providers.ts"

export interface PullRequestProps {
  /**
   * Repository owner (user or organization).
   */
  owner: string

  /**
   * Repository name.
   */
  repository: string

  /**
   * Pull request title.
   */
  title: string

  /**
   * Pull request body (supports GitHub Markdown).
   *
   * The body is automatically dedented, so you can use indented template
   * literals without worrying about leading whitespace. Accepts
   * `Output<string>` at the call site via `Output.interpolate` to embed
   * resource attributes that are not yet resolved.
   */
  body?: string

  /**
   * The name of the branch where your changes are implemented (the source).
   */
  head: string

  /**
   * The name of the branch you want the changes pulled into (the target).
   */
  base: string

  /**
   * State of the pull request. Use "open" to reopen a closed PR or "closed"
   * to close an open PR. Note: only the PR owner, repo owner, or user with
   * push access can close PRs.
   * @default "open"
   */
  state?: "open" | "closed"

  /**
   * Whether the pull request is a draft.
   * @default false
   */
  draft?: boolean

  /**
   * Labels to attach to the pull request. The provided list fully replaces
   * any existing labels.
   */
  labels?: string[]

  /**
   * Assignees (user logins) to assign to the pull request. The provided list
   * fully replaces existing assignees.
   */
  assignees?: string[]

  /**
   * Reviewers (user logins) to request reviews from. The provided list fully
   * replaces existing review requests.
   */
  reviewers?: string[]

  /**
   * Team slugs (for organization repos) to request reviews from.
   */
  teamReviewers?: string[]

  /**
   * Milestone number to assign to the pull request. Use `null` to remove
   * milestone.
   */
  milestone?: number | null

  /**
   * Whether to maintain the original author of the PR when updating. When
   * false (default), updates may change apparent authorship depending on
   * token permissions.
   * @default false
   */
  maintainerCanModify?: boolean

  /**
   * Override the GitHub host or API base URL for this resource only (e.g.
   * `github.example.com` for GitHub Enterprise). Falls back to
   * `GitHub.providers({ baseUrl })`, then to the host resolved by the auth
   * provider. Changing it replaces the resource — the same name on a
   * different GitHub instance is a different physical resource.
   */
  baseUrl?: string
}

export interface PullRequest extends Resource<
  "GitHub.PullRequest",
  PullRequestProps,
  {
    /**
     * The numeric ID of the pull request in GitHub.
     */
    prNumber: number

    /**
     * GraphQL node ID of the pull request.
     */
    nodeId: string

    /**
     * URL to view the pull request in a browser.
     */
    htmlUrl: string

    /**
     * State of the pull request (open or closed).
     */
    state: "open" | "closed"

    /**
     * Whether the pull request is merged.
     */
    merged: boolean

    /**
     * Whether the pull request is a draft.
     */
    draft: boolean

    /**
     * ISO-8601 timestamp of when the pull request was created.
     */
    createdAt: string

    /**
     * ISO-8601 timestamp of the last update.
     */
    updatedAt: string
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
})

export const PullRequestProvider = () =>
  Provider.succeed(PullRequest, {
    stables: ["prNumber", "nodeId"],

    // A PR belongs to (host, owner, repository, head, base) — changing any
    // of these replaces the resource: a fresh PR is created with the new
    // configuration, and the old one is retained by default.
    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news)) return
      if (olds === undefined) return
      if (
        news.owner !== olds.owner ||
        news.repository !== olds.repository ||
        news.head !== olds.head ||
        news.base !== olds.base ||
        (yield* gitHubBaseUrlChanged(olds, news))
      ) {
        return { action: "replace" }
      }
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const octokit = yield* octokitFor(news.baseUrl)
      const body = news.body ? dedent(news.body) : undefined

      // Observe — GitHub assigns `number` server-side. Probe for live state
      // via the cached number; a 404 (deleted out-of-band, or never created)
      // collapses to "no observed PR" so we converge by creating a fresh one.
      const observedNumber = output?.prNumber
        ? yield* Effect.tryPromise({
            try: async () => {
              try {
                const { data } = await octokit.rest.pulls.get({
                  owner: news.owner,
                  repo: news.repository,
                  pull_number: output.prNumber,
                })
                return data.number
              } catch (error: any) {
                if (error.status === 404) return undefined
                throw error
              }
            },
            catch: (e) => e as Error,
          })
        : undefined

      // Ensure — when no live PR exists, POST creates one.
      if (observedNumber === undefined) {
        const { data } = yield* Effect.tryPromise(() =>
          octokit.rest.pulls.create({
            owner: news.owner,
            repo: news.repository,
            title: news.title,
            body,
            head: news.head,
            base: news.base,
            draft: news.draft,
            maintainer_can_modify: news.maintainerCanModify,
          }),
        )

        // Apply labels, assignees, milestone, and reviewers after creation
        yield* syncPullRequestMeta(octokit, news, data.number)

        return {
          prNumber: data.number,
          nodeId: data.node_id,
          htmlUrl: data.html_url,
          state: data.state as "open" | "closed",
          merged: data.merged,
          draft: data.draft ?? false,
          createdAt: data.created_at,
          updatedAt: data.updated_at,
        }
      }

      // Sync — PATCH the existing PR with the desired properties. GitHub's
      // update is idempotent, so we always issue the call rather than diffing.
      const { data } = yield* Effect.tryPromise(() =>
        octokit.rest.pulls.update({
          owner: news.owner,
          repo: news.repository,
          pull_number: observedNumber,
          title: news.title,
          body,
          state: news.state,
          base: news.base,
          maintainer_can_modify: news.maintainerCanModify,
        }),
      )

      // Sync draft state separately (different endpoint)
      if (news.draft !== undefined) {
        if (news.draft && !data.draft) {
          yield* Effect.tryPromise(() =>
            octokit.rest.pulls.update({
              owner: news.owner,
              repo: news.repository,
              pull_number: observedNumber,
              // @ts-expect-error draft is valid but not in types
              draft: true,
            }),
          )
        } else if (!news.draft && data.draft) {
          yield* Effect.tryPromise(() =>
            octokit.rest.pulls.markAsReadyForReview({
              owner: news.owner,
              repo: news.repository,
              pull_number: observedNumber,
            }),
          )
        }
      }

      // Sync labels, assignees, milestone, and reviewers
      yield* syncPullRequestMeta(octokit, news, observedNumber)

      return {
        prNumber: data.number,
        nodeId: data.node_id,
        htmlUrl: data.html_url,
        state: data.state as "open" | "closed",
        merged: data.merged,
        draft: data.draft ?? false,
        createdAt: data.created_at,
        updatedAt: data.updated_at,
      }
    }),

    // Enumerate every pull request across the repositories the token can see.
    list: Effect.fn(function* () {
      const octokit = yield* Octokit

      const repos = yield* Effect.tryPromise({
        try: () =>
          octokit.paginate(octokit.rest.repos.listForAuthenticatedUser, {
            per_page: 100,
          }),
        catch: (e) => e as Error,
      })

      const perRepo = yield* Effect.forEach(
        repos,
        (repo) =>
          Effect.tryPromise({
            try: async () => {
              try {
                const pulls = await octokit.paginate(
                  octokit.rest.pulls.list,
                  {
                    owner: repo.owner.login,
                    repo: repo.name,
                    state: "all",
                    per_page: 100,
                  },
                )
                return pulls.map((pr) => ({
                  prNumber: pr.number,
                  nodeId: pr.node_id,
                  htmlUrl: pr.html_url,
                  state: pr.state as "open" | "closed",
                  merged: pr.merged ?? false,
                  draft: pr.draft ?? false,
                  createdAt: pr.created_at,
                  updatedAt: pr.updated_at,
                }))
              } catch (error: any) {
                if (error.status === 403 || error.status === 404) {
                  return []
                }
                throw error
              }
            },
            catch: (e) => e as Error,
          }),
        { concurrency: 10 },
      )

      return perRepo.flat()
    }),

    delete: Effect.fn(function* ({ olds, output }) {
      const octokit = yield* octokitFor(olds.baseUrl)

      // Close the PR on delete (GitHub API does not support deleting PRs)
      if (output?.prNumber !== undefined) {
        yield* Effect.tryPromise(async () => {
          try {
            await octokit.rest.pulls.update({
              owner: olds.owner,
              repo: olds.repository,
              pull_number: output.prNumber,
              state: "closed",
            })
          } catch (error: any) {
            if (error.status !== 404) {
              throw error
            }
          }
        })
      }
    }),
  })

const syncPullRequestMeta = Effect.fn(function* (
  octokit: any,
  props: PullRequestProps,
  prNumber: number,
) {
  // Sync labels
  if (props.labels !== undefined) {
    yield* Effect.tryPromise(() =>
      octokit.rest.issues.setLabels({
        owner: props.owner,
        repo: props.repository,
        issue_number: prNumber,
        labels: props.labels,
      }),
    )
  }

  // Sync assignees
  if (props.assignees !== undefined) {
    yield* Effect.tryPromise(() =>
      octokit.rest.issues.addAssignees({
        owner: props.owner,
        repo: props.repository,
        issue_number: prNumber,
        assignees: props.assignees,
      }),
    )
  }

  // Sync milestone
  if (props.milestone !== undefined) {
    yield* Effect.tryPromise(() =>
      octokit.rest.issues.update({
        owner: props.owner,
        repo: props.repository,
        issue_number: prNumber,
        milestone: props.milestone === null ? null : props.milestone,
      }),
    )
  }

  // Sync reviewers
  if (
    props.reviewers !== undefined ||
    props.teamReviewers !== undefined
  ) {
    yield* Effect.tryPromise(() =>
      octokit.rest.pulls.requestReviewers({
        owner: props.owner,
        repo: props.repository,
        pull_number: prNumber,
        reviewers: props.reviewers ?? [],
        team_reviewers: props.teamReviewers ?? [],
      }),
    )
  }
})
