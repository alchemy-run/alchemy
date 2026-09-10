import * as Effect from "effect/Effect"
import { isResolved } from "../Diff.ts"
import * as Provider from "../Provider.ts"
import { Resource } from "../Resource.ts"
import { gitHubBaseUrlChanged, Octokit, octokitFor } from "./Octokit.ts"
import type * as GitHub from "./Providers.ts"

export interface LabelProps {
  /**
   * Repository owner (user or organization).
   */
  owner: string

  /**
   * Repository name.
   */
  repository: string

  /**
   * Label name. Changing the name replaces the label (creates new, deletes
   * old) — GitHub has no rename API.
   */
  name: string

  /**
   * Label color in hexadecimal format without leading `#` (e.g. `"ff0000"`
   * for red). Defaults to a random color if omitted.
   */
  color?: string

  /**
   * Label description (up to 100 characters).
   */
  description?: string

  /**
   * Override the GitHub host or API base URL for this resource only (e.g.
   * `github.example.com` for GitHub Enterprise). Falls back to
   * `GitHub.providers({ baseUrl })`, then to the host resolved by the auth
   * provider. Changing it replaces the resource — the same name on a
   * different GitHub instance is a different physical resource.
   */
  baseUrl?: string
}

export interface Label extends Resource<
  "GitHub.Label",
  LabelProps,
  {
    /**
     * The label name.
     */
    name: string

    /**
     * Label color (hex without #).
     */
    color: string

    /**
     * Label description.
     */
    description: string

    /**
     * Whether this is a default label.
     */
    default: boolean

    /**
     * GraphQL node ID of the label.
     */
    nodeId: string

    /**
     * URL to view the label in a browser.
     */
    url: string
  },
  never,
  GitHub.Providers
> {}

/**
 * A GitHub repository label.
 *
 * `Label` manages the lifecycle of a repository label used to categorize
 * issues and pull requests. Labels are created on first deploy and updated in
 * place when properties change.
 *
 * Authentication is resolved via the `GitHubCredentials` service supplied by
 * `GitHub.providers()` (env, stored PAT, `gh` CLI, or OAuth). The token needs
 * `repo` scope for private repositories or `public_repo` for public ones.
 *
 * ### Creating Labels
 * **Example:** Create a Bug Label
 * ```typescript
 * const bugLabel = yield* GitHub.Label("bug", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   name: "bug",
 *   color: "d73a4a",
 *   description: "Something isn't working",
 * })
 * ```
 *
 * **Example:** Create Multiple Labels
 * ```typescript
 * yield* GitHub.Label("priority-high", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   name: "priority: high",
 *   color: "ff0000",
 *   description: "High priority issue",
 * })
 *
 * yield* GitHub.Label("priority-low", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   name: "priority: low",
 *   color: "0e8a16",
 *   description: "Low priority issue",
 * })
 * ```
 *
 * ### Label Organization
 * **Example:** Category Labels
 * ```typescript
 * // Status labels
 * yield* GitHub.Label("status-in-progress", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   name: "status: in progress",
 *   color: "fbca04",
 * })
 *
 * yield* GitHub.Label("status-blocked", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   name: "status: blocked",
 *   color: "b60205",
 * })
 * ```
 *
 * ### Updating Labels
 * Deploy with the same logical ID and different properties to update the
 * existing label in place. Note: changing `name` replaces the label rather
 * than renaming it.
 *
 * **Example:** Update Label Color
 * ```typescript
 * yield* GitHub.Label("enhancement", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   name: "enhancement",
 *   color: "a2eeef",
 *   description: "New feature or request",
 * })
 * ```
 *
 * @resource
 */
export const Label = Resource<Label>("GitHub.Label")

export const LabelProvider = () =>
  Provider.succeed(Label, {
    stables: ["nodeId"],

    // A label belongs to (host, owner, repository, name). GitHub has no
    // rename API, so changing name replaces the label: a new label is
    // created with the new name, and the old one is deleted.
    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news)) return
      if (olds === undefined) return
      if (
        news.owner !== olds.owner ||
        news.repository !== olds.repository ||
        news.name !== olds.name ||
        (yield* gitHubBaseUrlChanged(olds, news))
      ) {
        return { action: "replace" }
      }
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const octokit = yield* octokitFor(news.baseUrl)

      // Observe — probe for the live label by name. A 404 (deleted
      // out-of-band, or never created) collapses to "no observed label" so
      // we converge by creating a fresh one.
      const observed = yield* Effect.tryPromise({
        try: async () => {
          try {
            const { data } = await octokit.rest.issues.getLabel({
              owner: news.owner,
              repo: news.repository,
              name: news.name,
            })
            return data
          } catch (error: any) {
            if (error.status === 404) return undefined
            throw error
          }
        },
        catch: (e) => e as Error,
      })

      // Ensure — when no live label exists, POST creates one.
      if (observed === undefined) {
        const { data } = yield* Effect.tryPromise(() =>
          octokit.rest.issues.createLabel({
            owner: news.owner,
            repo: news.repository,
            name: news.name,
            color: news.color,
            description: news.description,
          }),
        )
        return {
          name: data.name,
          color: data.color,
          description: data.description ?? "",
          default: data.default,
          nodeId: data.node_id,
          url: data.url,
        }
      }

      // Sync — PATCH the existing label with the desired properties.
      // GitHub's updateLabel is idempotent for identical values, so we
      // always issue the call rather than diffing.
      const { data } = yield* Effect.tryPromise(() =>
        octokit.rest.issues.updateLabel({
          owner: news.owner,
          repo: news.repository,
          name: news.name,
          color: news.color,
          description: news.description,
        }),
      )
      return {
        name: data.name,
        color: data.color,
        description: data.description ?? "",
        default: data.default,
        nodeId: data.node_id,
        url: data.url,
      }
    }),

    // Enumerate every label across the repositories the token can see.
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
                const labels = await octokit.paginate(
                  octokit.rest.issues.listLabelsForRepo,
                  {
                    owner: repo.owner.login,
                    repo: repo.name,
                    per_page: 100,
                  },
                )
                return labels.map((label) => ({
                  name: label.name,
                  color: label.color,
                  description: label.description ?? "",
                  default: label.default,
                  nodeId: label.node_id,
                  url: label.url,
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

    delete: Effect.fn(function* ({ olds }) {
      const octokit = yield* octokitFor(olds.baseUrl)

      yield* Effect.tryPromise(async () => {
        try {
          await octokit.rest.issues.deleteLabel({
            owner: olds.owner,
            repo: olds.repository,
            name: olds.name,
          })
        } catch (error: any) {
          if (error.status !== 404) {
            throw error
          }
        }
      })
    }),
  })
