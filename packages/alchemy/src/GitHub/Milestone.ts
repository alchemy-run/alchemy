import * as Effect from "effect/Effect"
import { isResolved } from "../Diff.ts"
import * as Provider from "../Provider.ts"
import { Resource } from "../Resource.ts"
import { dedent } from "../Util/dedent.ts"
import { gitHubBaseUrlChanged, Octokit, octokitFor } from "./Octokit.ts"
import type * as GitHub from "./Providers.ts"

export interface MilestoneProps {
  /**
   * Repository owner (user or organization).
   */
  owner: string

  /**
   * Repository name.
   */
  repository: string

  /**
   * Milestone title.
   */
  title: string

  /**
   * Milestone description (supports GitHub Markdown).
   *
   * The description is automatically dedented, so you can use indented
   * template literals without worrying about leading whitespace.
   */
  description?: string

  /**
   * State of the milestone.
   * @default "open"
   */
  state?: "open" | "closed"

  /**
   * Due date for the milestone (ISO-8601 format, e.g. "2026-12-31T23:59:59Z").
   * Use `null` to remove an existing due date.
   */
  dueOn?: string | null

  /**
   * Override the GitHub host or API base URL for this resource only (e.g.
   * `github.example.com` for GitHub Enterprise). Falls back to
   * `GitHub.providers({ baseUrl })`, then to the host resolved by the auth
   * provider. Changing it replaces the resource — the same name on a
   * different GitHub instance is a different physical resource.
   */
  baseUrl?: string
}

export interface Milestone extends Resource<
  "GitHub.Milestone",
  MilestoneProps,
  {
    /**
     * The numeric ID of the milestone in GitHub.
     */
    milestoneNumber: number

    /**
     * GraphQL node ID of the milestone.
     */
    nodeId: string

    /**
     * Milestone title.
     */
    title: string

    /**
     * State of the milestone (open or closed).
     */
    state: "open" | "closed"

    /**
     * URL to view the milestone in a browser.
     */
    htmlUrl: string

    /**
     * Number of open issues in this milestone.
     */
    openIssues: number

    /**
     * Number of closed issues in this milestone.
     */
    closedIssues: number

    /**
     * ISO-8601 timestamp of when the milestone was created.
     */
    createdAt: string

    /**
     * ISO-8601 timestamp of the last update.
     */
    updatedAt: string

    /**
     * ISO-8601 timestamp of the due date (if set).
     */
    dueOn: string | null

    /**
     * ISO-8601 timestamp of when the milestone was closed (if closed).
     */
    closedAt: string | null
  },
  never,
  GitHub.Providers
> {}

/**
 * A GitHub repository milestone.
 *
 * `Milestone` manages the lifecycle of a repository milestone used to group
 * issues and pull requests for releases or sprints. Milestones are created on
 * first deploy and updated in place when properties change.
 *
 * Authentication is resolved via the `GitHubCredentials` service supplied by
 * `GitHub.providers()` (env, stored PAT, `gh` CLI, or OAuth). The token needs
 * `repo` scope for private repositories or `public_repo` for public ones.
 *
 * ### Creating Milestones
 * **Example:** Create a Release Milestone
 * ```typescript
 * const v1Milestone = yield* GitHub.Milestone("v1-0", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   title: "v1.0 Release",
 *   description: "First major release with core features.",
 *   dueOn: "2026-12-31T23:59:59Z",
 * })
 * ```
 *
 * **Example:** Sprint Milestone
 * ```typescript
 * const sprintMilestone = yield* GitHub.Milestone("sprint-42", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   title: "Sprint 42",
 *   description: `
 *     ## Goals
 *     - Complete authentication system
 *     - Implement dark mode
 *     - Fix critical bugs
 *   `,
 *   dueOn: "2026-10-15T23:59:59Z",
 *   state: "open",
 * })
 * ```
 *
 * ### Updating Milestones
 * Deploy with the same logical ID and different properties to update the
 * existing milestone in place.
 *
 * **Example:** Close Milestone
 * ```typescript
 * yield* GitHub.Milestone("v1-0", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   title: "v1.0 Release",
 *   description: "Released successfully!",
 *   state: "closed",
 * })
 * ```
 *
 * ### Tracking Progress
 * The milestone's output attributes include `openIssues` and `closedIssues`
 * counts that update automatically as issues are opened, closed, or moved.
 *
 * **Example:** Use Milestone Outputs
 * ```typescript
 * const milestone = yield* GitHub.Milestone("current-sprint", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   title: "Current Sprint",
 * })
 *
 * // Access progress in other resources
 * yield* GitHub.Issue("sprint-status", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   title: "Sprint Status",
 *   body: Output.interpolate`
 *     Progress: ${milestone.closedIssues}/${milestone.openIssues.pipe(
 *       Output.map(open => open + milestone.closedIssues.as<number>())
 *     )} complete
 *   `,
 * })
 * ```
 *
 * @resource
 */
export const Milestone = Resource<Milestone>("GitHub.Milestone")

export const MilestoneProvider = () =>
  Provider.succeed(Milestone, {
    stables: ["milestoneNumber", "nodeId"],

    // A milestone belongs to (host, owner, repository) and is identified by
    // its server-assigned number. Changing owner, repository, or host
    // replaces the resource.
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
      const description = news.description ? dedent(news.description) : undefined

      // Observe — GitHub assigns `number` server-side. Probe for live state
      // via the cached number; a 404 (deleted out-of-band, or never created)
      // collapses to "no observed milestone" so we converge by creating a
      // fresh one.
      const observedNumber = output?.milestoneNumber
        ? yield* Effect.tryPromise({
            try: async () => {
              try {
                const { data } = await octokit.rest.issues.getMilestone({
                  owner: news.owner,
                  repo: news.repository,
                  milestone_number: output.milestoneNumber,
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

      // Ensure — when no live milestone exists, POST creates one.
      if (observedNumber === undefined) {
        const { data } = yield* Effect.tryPromise(() =>
          octokit.rest.issues.createMilestone({
            owner: news.owner,
            repo: news.repository,
            title: news.title,
            description,
            due_on:
              news.dueOn === null || news.dueOn === undefined
                ? undefined
                : news.dueOn,
            state: news.state,
          }),
        )
        return {
          milestoneNumber: data.number,
          nodeId: data.node_id,
          title: data.title,
          state: data.state as "open" | "closed",
          htmlUrl: data.html_url,
          openIssues: data.open_issues,
          closedIssues: data.closed_issues,
          createdAt: data.created_at,
          updatedAt: data.updated_at,
          dueOn: data.due_on ?? null,
          closedAt: data.closed_at ?? null,
        }
      }

      // Sync — PATCH the existing milestone with the desired properties.
      // GitHub's updateMilestone is idempotent for identical values, so we
      // always issue the call rather than diffing.
      const { data } = yield* Effect.tryPromise(() =>
        octokit.rest.issues.updateMilestone({
          owner: news.owner,
          repo: news.repository,
          milestone_number: observedNumber,
          title: news.title,
          description,
          due_on:
            news.dueOn === null || news.dueOn === undefined
              ? undefined
              : news.dueOn,
          state: news.state,
        }),
      )
      return {
        milestoneNumber: data.number,
        nodeId: data.node_id,
        title: data.title,
        state: data.state as "open" | "closed",
        htmlUrl: data.html_url,
        openIssues: data.open_issues,
        closedIssues: data.closed_issues,
        createdAt: data.created_at,
        updatedAt: data.updated_at,
        dueOn: data.due_on ?? null,
        closedAt: data.closed_at ?? null,
      }
    }),

    // Enumerate every milestone across the repositories the token can see.
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
                const milestones = await octokit.paginate(
                  octokit.rest.issues.listMilestones,
                  {
                    owner: repo.owner.login,
                    repo: repo.name,
                    state: "all",
                    per_page: 100,
                  },
                )
                return milestones.map((milestone) => ({
                  milestoneNumber: milestone.number,
                  nodeId: milestone.node_id,
                  title: milestone.title,
                  state: milestone.state as "open" | "closed",
                  htmlUrl: milestone.html_url,
                  openIssues: milestone.open_issues,
                  closedIssues: milestone.closed_issues,
                  createdAt: milestone.created_at,
                  updatedAt: milestone.updated_at,
                  dueOn: milestone.due_on ?? null,
                  closedAt: milestone.closed_at ?? null,
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

      if (output?.milestoneNumber !== undefined) {
        yield* Effect.tryPromise(async () => {
          try {
            await octokit.rest.issues.deleteMilestone({
              owner: olds.owner,
              repo: olds.repository,
              milestone_number: output.milestoneNumber,
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
