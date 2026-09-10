import * as Effect from "effect/Effect"
import { isResolved } from "../Diff.ts"
import * as Provider from "../Provider.ts"
import { Resource } from "../Resource.ts"
import { gitHubBaseUrlChanged, octokitFor } from "./Octokit.ts"
import type * as GitHub from "./Providers.ts"

export interface BranchProtectionProps {
  /**
   * Repository owner — a user or organization login.
   */
  owner: string

  /**
   * Repository name.
   */
  repository: string

  /**
   * Branch name or pattern to protect (e.g. `main`, `release/*`).
   */
  branch: string

  /**
   * Required status checks configuration.
   */
  requiredStatusChecks?: {
    /**
     * Whether to require branches to be up to date before merging.
     * @default false
     */
    strict?: boolean

    /**
     * List of required status check contexts (e.g. `["ci/test", "ci/lint"]`).
     */
    contexts?: string[]
  }

  /**
   * Enforce restrictions for administrators.
   * @default false
   */
  enforceAdmins?: boolean

  /**
   * Required pull request reviews configuration.
   */
  requiredPullRequestReviews?: {
    /**
     * Dismiss stale reviews when new commits are pushed.
     * @default false
     */
    dismissStaleReviews?: boolean

    /**
     * Require code owner reviews.
     * @default false
     */
    requireCodeOwnerReviews?: boolean

    /**
     * Number of required approving reviews (1-6).
     */
    requiredApprovingReviewCount?: number

    /**
     * Restrict who can dismiss pull request reviews. Specify user logins
     * or team slugs.
     */
    dismissalRestrictions?: {
      users?: string[]
      teams?: string[]
    }

    /**
     * Restrict who can push to matching branches. Specify user logins,
     * team slugs, or app slugs.
     */
    bypassPullRequestAllowances?: {
      users?: string[]
      teams?: string[]
      apps?: string[]
    }
  }

  /**
   * Restrict who can push to matching branches. Specify user logins or
   * team slugs. An empty object enables restrictions with no users/teams
   * (only admins can push).
   */
  restrictions?: {
    users?: string[]
    teams?: string[]
    apps?: string[]
  }

  /**
   * Require signed commits.
   * @default false
   */
  requiredSignatures?: boolean

  /**
   * Require linear history.
   * @default false
   */
  requiredLinearHistory?: boolean

  /**
   * Allow force pushes for everyone, admins only, or no one.
   * @default false
   */
  allowForcePushes?: boolean

  /**
   * Allow deletions of the protected branch.
   * @default false
   */
  allowDeletions?: boolean

  /**
   * Require conversation resolution before merging.
   * @default false
   */
  requiredConversationResolution?: boolean

  /**
   * Override the GitHub host or API base URL for this resource only (e.g.
   * `github.example.com` for GitHub Enterprise). Falls back to
   * `GitHub.providers({ baseUrl })`, then to the host resolved by the auth
   * provider. Changing it replaces the resource — the same name on a
   * different GitHub instance is a different physical resource.
   */
  baseUrl?: string
}

export interface BranchProtection extends Resource<
  "GitHub.BranchProtection",
  BranchProtectionProps,
  {
    /**
     * The protected branch pattern.
     */
    branch: string

    /**
     * Whether admin enforcement is enabled.
     */
    enforceAdmins: boolean

    /**
     * URL to view the branch protection settings.
     */
    url: string
  },
  never,
  GitHub.Providers
> {}

/**
 * A GitHub branch protection rule.
 *
 * `BranchProtection` manages branch protection settings using the legacy
 * branch protection API. For new implementations, prefer `GitHub.Ruleset`
 * which provides more flexible targeting and additional features. This
 * resource remains useful for compatibility with existing workflows and
 * tooling.
 *
 * Branch protections default to **retain** on removal — destroying the stack
 * does NOT remove the protection rule, preventing accidental exposure of
 * protected branches. Opt in to actual deletion by wrapping the resource in
 * {@link destroy}() from `alchemy/RemovalPolicy`.
 *
 * Authentication is resolved via the `GitHubCredentials` service supplied by
 * `GitHub.providers()` (env, stored PAT, `gh` CLI, or OAuth). The token needs
 * `repo` scope.
 *
 * ### Basic Protection
 * **Example:** Protect Main Branch
 * ```typescript
 * yield* GitHub.BranchProtection("main-protection", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   branch: "main",
 *   enforceAdmins: true,
 *   requiredLinearHistory: true,
 * })
 * ```
 *
 * ### Require Reviews
 * **Example:** Require PR Reviews with Code Owners
 * ```typescript
 * yield* GitHub.BranchProtection("require-reviews", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   branch: "main",
 *   requiredPullRequestReviews: {
 *     requiredApprovingReviewCount: 2,
 *     requireCodeOwnerReviews: true,
 *     dismissStaleReviews: true,
 *   },
 *   requiredConversationResolution: true,
 * })
 * ```
 *
 * ### Status Checks
 * **Example:** Require CI to Pass
 * ```typescript
 * yield* GitHub.BranchProtection("ci-checks", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   branch: "main",
 *   requiredStatusChecks: {
 *     strict: true,
 *     contexts: ["ci/test", "ci/lint", "ci/build"],
 *   },
 * })
 * ```
 *
 * ### Push Restrictions
 * **Example:** Restrict Who Can Push
 * ```typescript
 * yield* GitHub.BranchProtection("restricted-push", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   branch: "main",
 *   restrictions: {
 *     users: ["release-manager"],
 *     teams: ["platform"],
 *   },
 * })
 * ```
 *
 * @resource
 */
export const BranchProtection = Resource<BranchProtection>(
  "GitHub.BranchProtection",
  {
    defaultRemovalPolicy: "retain",
  },
)

export const BranchProtectionProvider = () =>
  Provider.succeed(BranchProtection, {
    // Branch protection is keyed by (owner, repository, branch, host) — the
    // GitHub API has no ID or rename, so changing any of those replaces.
    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news)) return
      if (olds === undefined) return
      if (
        news.owner !== olds.owner ||
        news.repository !== olds.repository ||
        news.branch !== olds.branch ||
        (yield* gitHubBaseUrlChanged(olds, news))
      ) {
        return { action: "replace" }
      }
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const octokit = yield* octokitFor(news.baseUrl)

      // Build the protection payload
      const protection: any = {
        required_status_checks: news.requiredStatusChecks
          ? {
              strict: news.requiredStatusChecks.strict ?? false,
              contexts: news.requiredStatusChecks.contexts ?? [],
            }
          : null,
        enforce_admins: news.enforceAdmins ?? false,
        required_pull_request_reviews: news.requiredPullRequestReviews
          ? {
              dismissal_restrictions:
                news.requiredPullRequestReviews.dismissalRestrictions
                  ? {
                      users: news.requiredPullRequestReviews.dismissalRestrictions.users ?? [],
                      teams: news.requiredPullRequestReviews.dismissalRestrictions.teams ?? [],
                    }
                  : undefined,
              dismiss_stale_reviews: news.requiredPullRequestReviews.dismissStaleReviews ?? false,
              require_code_owner_reviews: news.requiredPullRequestReviews.requireCodeOwnerReviews ?? false,
              required_approving_review_count: news.requiredPullRequestReviews.requiredApprovingReviewCount,
              bypass_pull_request_allowances:
                news.requiredPullRequestReviews.bypassPullRequestAllowances
                  ? {
                      users: news.requiredPullRequestReviews.bypassPullRequestAllowances.users ?? [],
                      teams: news.requiredPullRequestReviews.bypassPullRequestAllowances.teams ?? [],
                      apps: news.requiredPullRequestReviews.bypassPullRequestAllowances.apps ?? [],
                    }
                  : undefined,
            }
          : null,
        restrictions: news.restrictions
          ? {
              users: news.restrictions.users ?? [],
              teams: news.restrictions.teams ?? [],
              apps: news.restrictions.apps ?? [],
            }
          : null,
        required_linear_history: news.requiredLinearHistory ?? false,
        allow_force_pushes: news.allowForcePushes ?? false,
        allow_deletions: news.allowDeletions ?? false,
        required_conversation_resolution: news.requiredConversationResolution ?? false,
      }

      // Ensure & Sync — the PUT is idempotent; it creates or updates
      const result = yield* Effect.tryPromise({
        try: async () => {
          const { data } = await octokit.rest.repos.updateBranchProtection({
            owner: news.owner,
            repo: news.repository,
            branch: news.branch,
            ...protection,
          } as any)
          return data
        },
        catch: (e) => e as Error,
      })

      // Sync — required signatures is a separate endpoint
      if (news.requiredSignatures !== undefined) {
        if (news.requiredSignatures) {
          yield* Effect.tryPromise({
            try: () =>
              octokit.rest.repos.createCommitSignatureProtection({
                owner: news.owner,
                repo: news.repository,
                branch: news.branch,
              }),
            catch: (e) => e as Error,
          })
        } else {
          yield* Effect.tryPromise({
            try: async () => {
              try {
                await octokit.rest.repos.deleteCommitSignatureProtection({
                  owner: news.owner,
                  repo: news.repository,
                  branch: news.branch,
                })
              } catch (error: any) {
                if (error.status !== 404) throw error
              }
            },
            catch: (e) => e as Error,
          })
        }
      }

      return {
        branch: news.branch,
        enforceAdmins: result.enforce_admins?.enabled ?? false,
        url: result.url ?? "",
      }
    }),

    // Non-listable: branch protection is keyed by {owner, repository, branch}
    // with no ambient scope to enumerate from. Return an empty array.
    list: () => Effect.succeed([]),

    delete: Effect.fn(function* ({ olds }) {
      const octokit = yield* octokitFor(olds.baseUrl)

      yield* Effect.tryPromise({
        try: async () => {
          try {
            await octokit.rest.repos.deleteBranchProtection({
              owner: olds.owner,
              repo: olds.repository,
              branch: olds.branch,
            })
          } catch (error: any) {
            if (error.status !== 404) {
              throw error
            }
          }
        },
        catch: (e) => e as Error,
      })
    }),
  })
