import * as Effect from "effect/Effect"
import { isResolved } from "../Diff.ts"
import * as Provider from "../Provider.ts"
import { Resource } from "../Resource.ts"
import { dedent } from "../Util/dedent.ts"
import { gitHubBaseUrlChanged, Octokit, octokitFor } from "./Octokit.ts"
import type * as GitHub from "./Providers.ts"

export interface IssueProps {
  /**
   * Repository owner (user or organization).
   */
  owner: string

  /**
   * Repository name.
   */
  repository: string

  /**
   * Issue title.
   */
  title: string

  /**
   * Issue body (supports GitHub Markdown).
   *
   * The body is automatically dedented, so you can use indented template
   * literals without worrying about leading whitespace. Accepts
   * `Output<string>` at the call site via `Output.interpolate` to embed
   * resource attributes that are not yet resolved.
   */
  body?: string

  /**
   * State of the issue. Use "open" to reopen a closed issue or "closed" to
   * close an open issue.
   * @default "open"
   */
  state?: "open" | "closed"

  /**
   * Labels to attach to the issue. The provided list fully replaces any
   * existing labels.
   */
  labels?: string[]

  /**
   * Assignees (user logins) to assign to the issue. The provided list fully
   * replaces existing assignees.
   */
  assignees?: string[]

  /**
   * Milestone number to assign to the issue. Use `null` to remove milestone.
   */
  milestone?: number | null

  /**
   * Override the GitHub host or API base URL for this resource only (e.g.
   * `github.example.com` for GitHub Enterprise). Falls back to
   * `GitHub.providers({ baseUrl })`, then to the host resolved by the auth
   * provider. Changing it replaces the resource — the same name on a
   * different GitHub instance is a different physical resource.
   */
  baseUrl?: string
}

export interface Issue extends Resource<
  "GitHub.Issue",
  IssueProps,
  {
    /**
     * The numeric ID of the issue in GitHub.
     */
    issueNumber: number

    /**
     * GraphQL node ID of the issue.
     */
    nodeId: string

    /**
     * URL to view the issue in a browser.
     */
    htmlUrl: string

    /**
     * State of the issue (open or closed).
     */
    state: "open" | "closed"

    /**
     * ISO-8601 timestamp of when the issue was created.
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
 * A GitHub repository issue.
 *
 * `Issue` manages the lifecycle of a single issue in a repository. Issues are
 * created on the first deploy and updated in place on subsequent deploys when
 * properties change. By default, issues are retained on destruction to preserve
 * discussion history — set `destroy()` to opt in to deletion.
 *
 * Authentication is resolved via the `GitHubCredentials` service supplied by
 * `GitHub.providers()` (env, stored PAT, `gh` CLI, or OAuth). The token needs
 * `repo` scope for private repositories or `public_repo` for public ones.
 *
 * ### Creating Issues
 * **Example:** Create a Basic Issue
 * ```typescript
 * const issue = yield* GitHub.Issue("bug-report", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   title: "Bug: Application crashes on startup",
 *   body: "## Description\n\nThe application crashes when...",
 * })
 * ```
 *
 * **Example:** Issue with Labels and Assignees
 * ```typescript
 * const issue = yield* GitHub.Issue("feature-request", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   title: "Feature: Add dark mode",
 *   body: "Users have requested...",
 *   labels: ["enhancement", "ui"],
 *   assignees: ["developer1"],
 * })
 * ```
 *
 * ### Updating Issues
 * Deploy with the same logical ID and different properties to update the
 * existing issue in place rather than creating a new one.
 *
 * **Example:** Update Issue State
 * ```typescript
 * const issue = yield* GitHub.Issue("resolved-bug", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   title: "Bug: Application crashes on startup",
 *   body: "This has been resolved.",
 *   state: "closed",
 * })
 * ```
 *
 * ### Issue with Milestone
 * **Example:** Assign to Milestone
 * ```typescript
 * const issue = yield* GitHub.Issue("v1-task", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   title: "Implement authentication",
 *   milestone: 1,
 * })
 * ```
 *
 * ### Tracking Infrastructure Changes
 * A common pattern is creating issues to track infrastructure changes or
 * deployment status.
 *
 * **Example:** Infrastructure Status Issue
 * ```typescript
 * yield* GitHub.Issue("infra-status", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   title: "Infrastructure Status",
 *   body: Output.interpolate`
 *     ## Current Status
 *
 *     **Database:** ${database.endpoint}
 *     **Cache:** ${cache.endpoint}
 *   `,
 *   labels: ["infrastructure"],
 * })
 * ```
 *
 * @resource
 */
export const Issue = Resource<Issue>("GitHub.Issue", {
  defaultRemovalPolicy: "retain",
})

export const IssueProvider = () =>
  Provider.succeed(Issue, {
    stables: ["issueNumber", "nodeId"],

    // An issue belongs to (host, owner, repository) — its server-assigned
    // number is meaningless elsewhere, so moving it replaces the resource:
    // a fresh issue is created on the new repository, and the old one is
    // retained by default (matching the resource's `retain` removal policy).
    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news)) return
      if (olds === undefined) return
      if (
        news.owner !== olds.owner ||
        news.repository !== olds.repository ||
        (yield* gitHubBaseUrlChanged(olds, news))
      ) {
        return { action: "replace" }
      }
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const octokit = yield* octokitFor(news.baseUrl)
      const body = news.body ? dedent(news.body) : undefined

      // Observe — GitHub assigns `issue_number` server-side. Probe for live
      // state via the cached number; a 404 (deleted out-of-band, or never
      // created) collapses to "no observed issue" so we converge by creating
      // a fresh one.
      const observedNumber = output?.issueNumber
        ? yield* Effect.tryPromise({
            try: async () => {
              try {
                const { data } = await octokit.rest.issues.get({
                  owner: news.owner,
                  repo: news.repository,
                  issue_number: output.issueNumber,
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

      // Ensure — when no live issue exists, POST creates one.
      if (observedNumber === undefined) {
        const { data } = yield* Effect.tryPromise(() =>
          octokit.rest.issues.create({
            owner: news.owner,
            repo: news.repository,
            title: news.title,
            body,
            labels: news.labels,
            assignees: news.assignees,
            milestone:
              news.milestone === null ? undefined : news.milestone,
          }),
        )
        return {
          issueNumber: data.number,
          nodeId: data.node_id,
          htmlUrl: data.html_url,
          state: data.state as "open" | "closed",
          createdAt: data.created_at,
          updatedAt: data.updated_at,
        }
      }

      // Sync — PATCH the existing issue with the desired properties. GitHub's
      // update is idempotent, so we always issue the call rather than diffing.
      const { data } = yield* Effect.tryPromise(() =>
        octokit.rest.issues.update({
          owner: news.owner,
          repo: news.repository,
          issue_number: observedNumber,
          title: news.title,
          body,
          state: news.state,
          labels: news.labels,
          assignees: news.assignees,
          milestone:
            news.milestone === null ? null : news.milestone,
        }),
      )
      return {
        issueNumber: data.number,
        nodeId: data.node_id,
        htmlUrl: data.html_url,
        state: data.state as "open" | "closed",
        createdAt: data.created_at,
        updatedAt: data.updated_at,
      }
    }),

    // Enumerate every issue across the repositories the token can see.
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
                const issues = await octokit.paginate(
                  octokit.rest.issues.listForRepo,
                  {
                    owner: repo.owner.login,
                    repo: repo.name,
                    state: "all",
                    per_page: 100,
                  },
                )
                // Filter out pull requests (they appear in issues API)
                return issues
                  .filter((issue) => !issue.pull_request)
                  .map((issue) => ({
                    issueNumber: issue.number,
                    nodeId: issue.node_id,
                    htmlUrl: issue.html_url,
                    state: issue.state as "open" | "closed",
                    createdAt: issue.created_at,
                    updatedAt: issue.updated_at,
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

      // GitHub API does not support deleting issues directly. Issues are
      // retained on GitHub by default unless the resource opted in to
      // deletion via destroy(). In that case, we close the issue as the
      // closest equivalent to deletion.
      if (output?.issueNumber !== undefined) {
        yield* Effect.tryPromise(async () => {
          try {
            await octokit.rest.issues.update({
              owner: olds.owner,
              repo: olds.repository,
              issue_number: output.issueNumber,
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
