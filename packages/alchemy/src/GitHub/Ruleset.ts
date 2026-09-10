import * as Effect from "effect/Effect"
import { isResolved } from "../Diff.ts"
import * as Provider from "../Provider.ts"
import { Resource } from "../Resource.ts"
import { gitHubBaseUrlChanged, Octokit, octokitFor } from "./Octokit.ts"
import type * as GitHub from "./Providers.ts"

export interface RulesetProps {
  /**
   * Repository owner — a user or organization login.
   */
  owner: string

  /**
   * Repository name.
   */
  repository: string

  /**
   * Ruleset name. The name is displayed in the GitHub UI and can be updated.
   */
  name: string

  /**
   * The enforcement level of the ruleset. Can be `disabled`, `active`, or
   * `evaluate` (log-only mode).
   * @default "active"
   */
  enforcement?: "disabled" | "active" | "evaluate"

  /**
   * Conditions that determine which refs are targeted by the ruleset.
   * Omit to apply to all refs.
   */
  target?: "branch" | "tag"

  /**
   * Conditions for targeting refs. When omitted, applies to all refs of the
   * target type.
   */
  conditions?: {
    /**
     * Ref patterns to include (e.g. `["refs/heads/main", "refs/heads/release/*"]`).
     * Supports glob patterns.
     */
    include?: string[]

    /**
     * Ref patterns to exclude (e.g. `["refs/heads/dev/*"]`).
     * Supports glob patterns.
     */
    exclude?: string[]
  }

  /**
   * Whether the ruleset should apply to admins. When true, admins cannot
   * bypass the rules.
   * @default false
   */
  bypassActors?: Array<{
    /**
     * The type of actor that can bypass the ruleset.
     */
    actorType: "RepositoryRole" | "Team" | "Integration" | "OrganizationAdmin"

    /**
     * The ID of the actor (role ID, team ID, or integration ID).
     * Use 1 for RepositoryRole.maintain, 2 for write, 4 for admin, 5 for bypass.
     */
    actorId?: number

    /**
     * Whether the bypass applies to the actor.
     * @default "always"
     */
    bypassMode?: "always" | "pull_request"
  }>

  /**
   * Rules to enforce on the targeted refs.
   */
  rules?: {
    /**
     * Require status checks to pass before merging.
     */
    requiredStatusChecks?: {
      /**
       * Status checks that must pass. Each entry is a context name or
       * integration ID.
       */
      checks: Array<{
        /**
         * The status check context name.
         */
        context: string

        /**
         * Optional integration ID.
         */
        integrationId?: number
      }>

      /**
       * Whether to require branches to be up to date before merging.
       * @default false
       */
      strictRequiredStatusChecksPolicy?: boolean
    }

    /**
     * Require commits to be signed.
     */
    requiredSignatures?: boolean

    /**
     * Require pull request before merging.
     */
    pullRequest?: {
      /**
       * Number of required approving reviews.
       */
      requiredApprovingReviewCount?: number

      /**
       * Dismiss stale reviews when new commits are pushed.
       */
      dismissStaleReviewsOnPush?: boolean

      /**
       * Require review from code owners.
       */
      requireCodeOwnerReview?: boolean

      /**
       * Require approval of the most recent reviewable push.
       */
      requireLastPushApproval?: boolean

      /**
       * Required review thread resolution.
       */
      requiredReviewThreadResolution?: boolean
    }

    /**
     * Prevent creation of matching refs.
     */
    creation?: boolean

    /**
     * Prevent updates to matching refs.
     */
    update?: boolean

    /**
     * Prevent deletion of matching refs.
     */
    deletion?: boolean

    /**
     * Require linear history.
     */
    requiredLinearHistory?: boolean

    /**
     * Prevent force pushes.
     */
    nonFastForward?: boolean
  }

  /**
   * Override the GitHub host or API base URL for this resource only (e.g.
   * `github.example.com` for GitHub Enterprise). Falls back to
   * `GitHub.providers({ baseUrl })`, then to the host resolved by the auth
   * provider. Changing it replaces the resource — the same name on a
   * different GitHub instance is a different physical resource.
   */
  baseUrl?: string
}

export interface Ruleset extends Resource<
  "GitHub.Ruleset",
  RulesetProps,
  {
    /**
     * Numeric GitHub ruleset ID.
     */
    rulesetId: number

    /**
     * GraphQL node ID of the ruleset.
     */
    nodeId: string

    /**
     * The ruleset name.
     */
    name: string

    /**
     * ISO-8601 timestamp of when the ruleset was created.
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
 * A GitHub repository ruleset.
 *
 * `Ruleset` manages branch and tag protection rules at the repository level.
 * Rulesets replace the legacy branch protection API with a more flexible
 * system that can target multiple branches or tags with a single ruleset.
 *
 * Rulesets default to **retain** on removal — destroying the stack does NOT
 * delete the ruleset on GitHub, protecting production branches from
 * accidental removal. Opt in to actual deletion by wrapping the resource in
 * {@link destroy}() from `alchemy/RemovalPolicy`.
 *
 * Authentication is resolved via the `GitHubCredentials` service supplied by
 * `GitHub.providers()` (env, stored PAT, `gh` CLI, or OAuth). The token needs
 * `repo` scope (and `admin:repo` for deletion when opted in via `destroy()`).
 *
 * ### Creating a Ruleset
 * **Example:** Protect Main Branch
 * ```typescript
 * yield* GitHub.Ruleset("main-protection", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   name: "main protection",
 *   target: "branch",
 *   conditions: {
 *     include: ["refs/heads/main"],
 *   },
 *   rules: {
 *     nonFastForward: true,
 *     deletion: true,
 *     requiredLinearHistory: true,
 *   },
 * })
 * ```
 *
 * **Example:** Require PR Reviews
 * ```typescript
 * yield* GitHub.Ruleset("pr-reviews", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   name: "require reviews",
 *   target: "branch",
 *   conditions: {
 *     include: ["refs/heads/main", "refs/heads/release/*"],
 *   },
 *   rules: {
 *     pullRequest: {
 *       requiredApprovingReviewCount: 2,
 *       requireCodeOwnerReview: true,
 *       dismissStaleReviewsOnPush: true,
 *       requiredReviewThreadResolution: true,
 *     },
 *   },
 * })
 * ```
 *
 * ### Status Checks
 * **Example:** Require CI to Pass
 * ```typescript
 * yield* GitHub.Ruleset("ci-checks", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   name: "CI required",
 *   target: "branch",
 *   conditions: {
 *     include: ["refs/heads/main"],
 *   },
 *   rules: {
 *     requiredStatusChecks: {
 *       checks: [
 *         { context: "ci/test" },
 *         { context: "ci/lint" },
 *       ],
 *       strictRequiredStatusChecksPolicy: true,
 *     },
 *   },
 * })
 * ```
 *
 * ### Bypass Actors
 * **Example:** Allow Admins to Bypass
 * ```typescript
 * yield* GitHub.Ruleset("protected-with-bypass", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   name: "protected with bypass",
 *   target: "branch",
 *   conditions: {
 *     include: ["refs/heads/main"],
 *   },
 *   bypassActors: [
 *     { actorType: "RepositoryRole", actorId: 5 },
 *   ],
 *   rules: {
 *     nonFastForward: true,
 *   },
 * })
 * ```
 *
 * @resource
 */
export const Ruleset = Resource<Ruleset>("GitHub.Ruleset", {
  defaultRemovalPolicy: "retain",
})

export const RulesetProvider = () =>
  Provider.succeed(Ruleset, {
    stables: ["rulesetId", "nodeId"],

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

    reconcile: Effect.fn(function* ({ news, olds, output }) {
      const octokit = yield* octokitFor(news.baseUrl)

      // Observe — read the existing ruleset by ID if we have one
      let observed: any = undefined
      if (output?.rulesetId !== undefined) {
        observed = yield* Effect.tryPromise({
          try: async () => {
            try {
              const { data } = await octokit.rest.repos.getRepoRuleset({
                owner: news.owner,
                repo: news.repository,
                ruleset_id: output.rulesetId,
              })
              return data
            } catch (error: any) {
              if (error.status === 404) return undefined
              throw error
            }
          },
          catch: (e) => e as Error,
        })
      }

      // Build the rules payload
      const rules: any[] = []

      if (news.rules?.creation) {
        rules.push({ type: "creation" })
      }
      if (news.rules?.update !== undefined && !news.rules.update) {
        rules.push({ type: "update", parameters: { update_allows_fetch_and_merge: false } })
      }
      if (news.rules?.deletion) {
        rules.push({ type: "deletion" })
      }
      if (news.rules?.nonFastForward) {
        rules.push({ type: "non_fast_forward" })
      }
      if (news.rules?.requiredLinearHistory) {
        rules.push({ type: "required_linear_history" })
      }
      if (news.rules?.requiredSignatures) {
        rules.push({ type: "required_signatures" })
      }
      if (news.rules?.pullRequest) {
        rules.push({
          type: "pull_request",
          parameters: {
            required_approving_review_count: news.rules.pullRequest.requiredApprovingReviewCount,
            dismiss_stale_reviews_on_push: news.rules.pullRequest.dismissStaleReviewsOnPush,
            require_code_owner_review: news.rules.pullRequest.requireCodeOwnerReview,
            require_last_push_approval: news.rules.pullRequest.requireLastPushApproval,
            required_review_thread_resolution: news.rules.pullRequest.requiredReviewThreadResolution,
          },
        })
      }
      if (news.rules?.requiredStatusChecks) {
        rules.push({
          type: "required_status_checks",
          parameters: {
            required_status_checks: news.rules.requiredStatusChecks.checks.map((check) => ({
              context: check.context,
              integration_id: check.integrationId,
            })),
            strict_required_status_checks_policy: news.rules.requiredStatusChecks.strictRequiredStatusChecksPolicy,
          },
        })
      }

      // Build the conditions payload
      let conditions: any = undefined
      if (news.conditions) {
        conditions = {
          ref_name: {
            include: news.conditions.include ?? [],
            exclude: news.conditions.exclude ?? [],
          },
        }
      }

      // Build the bypass actors payload
      const bypassActors = news.bypassActors?.map((actor) => ({
        actor_type: actor.actorType,
        actor_id: actor.actorId,
        bypass_mode: actor.bypassMode ?? "always",
      }))

      // Ensure — create or update the ruleset
      if (observed === undefined) {
        observed = yield* Effect.tryPromise({
          try: async () => {
            const { data } = await octokit.rest.repos.createRepoRuleset({
              owner: news.owner,
              repo: news.repository,
              name: news.name,
              target: news.target ?? "branch",
              enforcement: news.enforcement ?? "active",
              bypass_actors: bypassActors ?? [],
              conditions,
              rules,
            } as any)
            return data
          },
          catch: (e) => e as Error,
        })
      } else {
        observed = yield* Effect.tryPromise({
          try: async () => {
            const { data } = await octokit.rest.repos.updateRepoRuleset({
              owner: news.owner,
              repo: news.repository,
              ruleset_id: output.rulesetId,
              name: news.name,
              target: news.target ?? "branch",
              enforcement: news.enforcement ?? "active",
              bypass_actors: bypassActors ?? [],
              conditions,
              rules,
            } as any)
            return data
          },
          catch: (e) => e as Error,
        })
      }

      return {
        rulesetId: observed.id,
        nodeId: observed.node_id,
        name: observed.name,
        createdAt: observed.created_at ?? new Date().toISOString(),
        updatedAt: observed.updated_at ?? new Date().toISOString(),
      }
    }),

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
                const rulesets = await octokit.paginate(
                  octokit.rest.repos.getRepoRulesets,
                  {
                    owner: repo.owner.login,
                    repo: repo.name,
                    per_page: 100,
                  },
                )
                return rulesets.map((ruleset: any) => ({
                  rulesetId: ruleset.id,
                  nodeId: ruleset.node_id,
                  name: ruleset.name,
                  createdAt: ruleset.created_at ?? new Date().toISOString(),
                  updatedAt: ruleset.updated_at ?? new Date().toISOString(),
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
      if (output?.rulesetId === undefined) return

      const octokit = yield* octokitFor(olds.baseUrl)

      yield* Effect.tryPromise({
        try: async () => {
          try {
            await octokit.rest.repos.deleteRepoRuleset({
              owner: olds.owner,
              repo: olds.repository,
              ruleset_id: output.rulesetId,
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
