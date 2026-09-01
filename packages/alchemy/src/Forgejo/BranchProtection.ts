import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import {
  ForgejoCredentials,
  ignoreInaccessible,
  optional,
  paginate,
} from "./Client.ts";
import { listAccessibleRepositories } from "./Lists.ts";
import { matchesDesired } from "./Settings.ts";
import type * as Forgejo from "./Providers.ts";

/**
 * Desired Forgejo branch-protection rule settings.
 */
export interface BranchProtectionProps {
  /**
   * Repository owner.
   */
  readonly owner: string;
  /**
   * Repository name.
   */
  readonly repository: string;
  /**
   * Rule name and endpoint identity.
   */
  readonly ruleName: string;
  /**
   * Required approving reviews.
   */
  readonly requiredApprovals?: number;
  /**
   * Require signed commits.
   */
  readonly requireSignedCommits?: boolean;
  /**
   * Require passing status checks.
   */
  readonly enableStatusCheck?: boolean;
  /**
   * Required status-check contexts.
   */
  readonly statusCheckContexts?: readonly string[];
  /**
   * Prevent merging after a rejected review.
   */
  readonly blockOnRejectedReviews?: boolean;
  /**
   * Prevent merging when branch is stale.
   */
  readonly blockOnOutdatedBranch?: boolean;
  /**
   * Apply protection to administrators.
   */
  readonly applyToAdmins?: boolean;
  /**
   * Users allowed to push.
   *
   * Forgejo only enforces a whitelist when {@link enablePushWhitelist} is on,
   * which defaults to `true` whenever this or {@link pushWhitelistTeams} is
   * non-empty.
   */
  readonly pushWhitelistUsernames?: readonly string[];
  /**
   * Teams allowed to push.
   *
   * See {@link pushWhitelistUsernames} for how the whitelist is enabled.
   */
  readonly pushWhitelistTeams?: readonly string[];
  /**
   * Whether direct pushes to the branch are permitted at all.
   *
   * @default true when a push whitelist is set, otherwise left unmanaged
   */
  readonly enablePush?: boolean;
  /**
   * Whether the push whitelist is enforced.
   *
   * @default true when a push whitelist is set, otherwise left unmanaged
   */
  readonly enablePushWhitelist?: boolean;
}

/**
 * Observed Forgejo branch-protection attributes.
 */
export interface BranchProtectionAttributes {
  /**
   * Repository owner. Carried on the attributes so account-wide teardown,
   * which has no state row to read props from, can still address the rule.
   */
  readonly owner: string;
  /**
   * Repository name.
   */
  readonly repository: string;
  /**
   * Rule name.
   */
  readonly ruleName: string;
}

/**
 * A Forgejo branch-protection resource.
 */
export interface BranchProtection extends Resource<
  "Forgejo.BranchProtection",
  BranchProtectionProps,
  BranchProtectionAttributes,
  never,
  Forgejo.Providers
> {}

/**
 * A branch-protection rule on a Forgejo repository.
 *
 * The rule name is the endpoint's identity and may be a glob, so `main` and
 * `release/*` are separate rules. Changing it replaces the resource.
 *
 * ### Protecting a Branch
 * **Example:** Require Reviews on the Default Branch
 * ```typescript
 * yield* Forgejo.BranchProtection("main", {
 *   owner: "acme",
 *   repository: "api",
 *   ruleName: "main",
 *   requiredApprovals: 2,
 *   blockOnRejectedReviews: true,
 *   blockOnOutdatedBranch: true,
 * });
 * ```
 *
 * **Example:** Require Status Checks
 * ```typescript
 * yield* Forgejo.BranchProtection("release", {
 *   owner: "acme",
 *   repository: "api",
 *   ruleName: "release/*",
 *   enableStatusCheck: true,
 *   statusCheckContexts: ["ci/build", "ci/test"],
 *   applyToAdmins: true,
 * });
 * ```
 *
 * ### Restricting Who Can Push
 * Declaring a whitelist enables push-whitelist enforcement automatically;
 * set `enablePush` or `enablePushWhitelist` explicitly to override.
 *
 * **Example:** Limit Pushes to a Team
 * ```typescript
 * yield* Forgejo.BranchProtection("main", {
 *   owner: "acme",
 *   repository: "api",
 *   ruleName: "main",
 *   pushWhitelistTeams: ["platform"],
 *   pushWhitelistUsernames: ["release-bot"],
 * });
 * ```
 *
 * @resource
 */
export const BranchProtection = Resource<BranchProtection>(
  "Forgejo.BranchProtection",
);

interface ApiBranchProtection {
  readonly rule_name: string;
  readonly required_approvals?: number;
  readonly require_signed_commits?: boolean;
  readonly enable_status_check?: boolean;
  readonly status_check_contexts?: readonly string[];
  readonly block_on_rejected_reviews?: boolean;
  readonly block_on_outdated_branch?: boolean;
  readonly apply_to_admins?: boolean;
  readonly push_whitelist_usernames?: readonly string[];
  readonly push_whitelist_teams?: readonly string[];
  readonly enable_push?: boolean;
  readonly enable_push_whitelist?: boolean;
}

const collection = (
  props: Pick<BranchProtectionProps, "owner" | "repository">,
) =>
  `/repos/${encodeURIComponent(props.owner)}/${encodeURIComponent(props.repository)}/branch_protections`;

const rulePath = (
  props: Pick<BranchProtectionProps, "owner" | "repository" | "ruleName">,
) => `${collection(props)}/${encodeURIComponent(props.ruleName)}`;

const attributesOf = (
  props: Pick<BranchProtectionProps, "owner" | "repository">,
  rule: ApiBranchProtection,
): BranchProtectionAttributes => ({
  owner: props.owner,
  repository: props.repository,
  ruleName: rule.rule_name,
});

const bodyOf = (props: BranchProtectionProps) => {
  // A whitelist is inert unless its enable flags are on, so declaring one
  // turns them on by default — otherwise the rule silently permits everyone.
  const hasPushWhitelist =
    (props.pushWhitelistUsernames?.length ?? 0) > 0 ||
    (props.pushWhitelistTeams?.length ?? 0) > 0;
  const whitelistDefault = hasPushWhitelist ? true : undefined;
  return {
    rule_name: props.ruleName,
    required_approvals: props.requiredApprovals,
    require_signed_commits: props.requireSignedCommits,
    enable_status_check: props.enableStatusCheck,
    status_check_contexts: props.statusCheckContexts,
    block_on_rejected_reviews: props.blockOnRejectedReviews,
    block_on_outdated_branch: props.blockOnOutdatedBranch,
    apply_to_admins: props.applyToAdmins,
    push_whitelist_usernames: props.pushWhitelistUsernames,
    push_whitelist_teams: props.pushWhitelistTeams,
    enable_push: props.enablePush ?? whitelistDefault,
    enable_push_whitelist: props.enablePushWhitelist ?? whitelistDefault,
  };
};

/**
 * Provider layer implementing branch-protection lifecycle.
 */
export const BranchProtectionProvider = () =>
  Provider.succeed(BranchProtection, {
    stables: ["ruleName", "owner", "repository"],
    diff: ({ news, olds }) =>
      Effect.succeed(
        isResolved(news) &&
          olds !== undefined &&
          (news.owner !== olds.owner ||
            news.repository !== olds.repository ||
            news.ruleName !== olds.ruleName)
          ? { action: "replace" as const }
          : undefined,
      ),
    list: Effect.fn(function* () {
      const client = yield* ForgejoCredentials;
      const repositories = yield* listAccessibleRepositories();
      const rules = yield* Effect.forEach(
        repositories,
        (repository) => {
          const props = {
            owner: repository.owner.login,
            repository: repository.name,
          };
          // This is the one list endpoint Forgejo does not paginate: it
          // accepts no `page`/`limit` and returns every rule at once.
          return ignoreInaccessible(
            client.request<readonly ApiBranchProtection[] | undefined>(
              "GET",
              collection(props),
            ),
            undefined as readonly ApiBranchProtection[] | undefined,
          ).pipe(
            Effect.map((found) => found ?? []),
            Effect.map((found) =>
              found.map((rule) => attributesOf(props, rule)),
            ),
          );
        },
        { concurrency: 8 },
      );
      return rules.flat();
    }),
    read: Effect.fn(function* ({ olds }) {
      const client = yield* ForgejoCredentials;
      const observed = yield* optional(
        client.request<ApiBranchProtection>("GET", rulePath(olds)),
      );
      return observed === undefined ? undefined : attributesOf(olds, observed);
    }),
    reconcile: Effect.fn(function* ({ news }) {
      const client = yield* ForgejoCredentials;

      // Observe: the rule name is the endpoint identity, so live state alone
      // decides whether this creates or updates.
      const observed = yield* optional(
        client.request<ApiBranchProtection>("GET", rulePath(news)),
      );

      if (observed === undefined) {
        const created = yield* client
          .request<ApiBranchProtection>("POST", collection(news), {
            body: bodyOf(news),
          })
          .pipe(
            // A concurrent create wins the race; converge onto the rule that
            // is already there. This endpoint declares 403/422/423 for an
            // existing rule, not 409, so the conflict arrives under those.
            Effect.catchTag(
              ["ForgejoForbidden", "ForgejoValidationError"],
              () =>
                client.request<ApiBranchProtection>("PATCH", rulePath(news), {
                  body: bodyOf(news),
                }),
            ),
          );
        return attributesOf(news, created);
      }

      // Sync only when the live rule differs from what was declared.
      const desired = bodyOf(news);
      const updated = matchesDesired(observed, desired)
        ? observed
        : yield* client.request<ApiBranchProtection>("PATCH", rulePath(news), {
            body: desired,
          });
      return attributesOf(news, updated);
    }),
    delete: Effect.fn(function* ({ output }) {
      if (output === undefined) return;
      const client = yield* ForgejoCredentials;
      // Address the rule from `output` alone: account-wide teardown has no
      // state row, so it passes the Attributes shape as `olds` too.
      yield* optional(client.request<void>("DELETE", rulePath(output)));
    }),
  });
