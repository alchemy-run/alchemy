import { Services } from "@distilled.cloud/forgejo";
import type { BranchProtection as ApiBranchProtection } from "@distilled.cloud/forgejo/repository";
import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
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
   * Forgejo only keeps this on while {@link enablePush} is on too — with
   * direct pushes disabled there is nothing for a whitelist to permit, so
   * asking for both records this as off, matching what the instance stores.
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

const target = (
  props: Pick<BranchProtectionProps, "owner" | "repository">,
) => ({ owner: props.owner, repo: props.repository });

const attributesOf = (
  props: Pick<BranchProtectionProps, "owner" | "repository">,
  rule: ApiBranchProtection,
): BranchProtectionAttributes => ({
  owner: props.owner,
  repository: props.repository,
  ruleName: rule.rule_name,
});

const copy = (list: readonly string[] | undefined) =>
  list === undefined ? undefined : [...list];

/**
 * The settings both the create and the edit endpoint accept. `rule_name` is
 * the endpoint identity, added by create alone — `EditBranchProtectionOption`
 * does not carry it.
 */
const settingsOf = (props: BranchProtectionProps) => {
  // A whitelist is inert unless its enable flags are on, so declaring one
  // turns them on by default — otherwise the rule silently permits everyone.
  const hasPushWhitelist =
    (props.pushWhitelistUsernames?.length ?? 0) > 0 ||
    (props.pushWhitelistTeams?.length ?? 0) > 0;
  const whitelistDefault = hasPushWhitelist ? true : undefined;
  const enablePush = props.enablePush ?? whitelistDefault;
  // Forgejo stores `enable_push_whitelist` as false whenever `enable_push` is
  // false, on create and on edit alike. Asking for a `true` it will not keep
  // never converges: every reconcile observes false, sees drift, and re-issues
  // the same edit. Apply the server's own rule here instead. An omitted prop
  // is `undefined`, which `&&` passes through, so it stays unmanaged.
  const enablePushWhitelist =
    (props.enablePushWhitelist ?? whitelistDefault) && enablePush === true;
  return {
    required_approvals: props.requiredApprovals,
    require_signed_commits: props.requireSignedCommits,
    enable_status_check: props.enableStatusCheck,
    status_check_contexts: copy(props.statusCheckContexts),
    block_on_rejected_reviews: props.blockOnRejectedReviews,
    block_on_outdated_branch: props.blockOnOutdatedBranch,
    apply_to_admins: props.applyToAdmins,
    push_whitelist_usernames: copy(props.pushWhitelistUsernames),
    push_whitelist_teams: copy(props.pushWhitelistTeams),
    enable_push: enablePush,
    enable_push_whitelist: enablePushWhitelist,
  };
};

const observe = (
  props: Pick<BranchProtectionProps, "owner" | "repository" | "ruleName">,
) =>
  Services.repository
    .repoGetBranchProtection({ ...target(props), name: props.ruleName })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const edit = (props: BranchProtectionProps) =>
  Services.repository.repoEditBranchProtection({
    ...target(props),
    name: props.ruleName,
    ...settingsOf(props),
  });

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
      const repositories = yield* listAccessibleRepositories();
      const rules = yield* Effect.forEach(
        repositories,
        (repository) => {
          const props = {
            owner: repository.owner.login,
            repository: repository.name,
          };
          // This is the one list endpoint Forgejo does not paginate: it
          // accepts no `page`/`limit` and returns every rule at once. A
          // repository the credential cannot read is skipped rather than
          // failing the whole sweep.
          return Services.repository
            .repoListBranchProtection(target(props))
            .pipe(
              Effect.catchTag(["NotFound", "Forbidden"], () =>
                Effect.succeed([] as readonly ApiBranchProtection[]),
              ),
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
      const observed = yield* observe(olds);
      return observed === undefined ? undefined : attributesOf(olds, observed);
    }),
    reconcile: Effect.fn(function* ({ news }) {
      // Observe: the rule name is the endpoint identity, so live state alone
      // decides whether this creates or updates.
      const observed = yield* observe(news);

      if (observed === undefined) {
        const created = yield* Services.repository
          .repoCreateBranchProtection({
            ...target(news),
            rule_name: news.ruleName,
            ...settingsOf(news),
          })
          .pipe(
            // A concurrent create wins the race; converge onto the rule that
            // is already there. This endpoint declares 403/422/423 for an
            // existing rule, not 409, so the conflict arrives under those.
            Effect.catchTag(["Forbidden", "UnprocessableEntity"], () =>
              edit(news),
            ),
          );
        return attributesOf(news, created);
      }

      // Sync only when the live rule differs from what was declared.
      const updated = matchesDesired(observed, settingsOf(news))
        ? observed
        : yield* edit(news);
      return attributesOf(news, updated);
    }),
    delete: Effect.fn(function* ({ output }) {
      if (output === undefined) return;
      // Address the rule from `output` alone: account-wide teardown has no
      // state row, so it passes the Attributes shape as `olds` too.
      yield* Services.repository
        .repoDeleteBranchProtection({
          ...target(output),
          name: output.ruleName,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
