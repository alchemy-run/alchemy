import { Services } from "@distilled.cloud/forgejo";
import type { BranchProtection as ApiBranchProtection } from "@distilled.cloud/forgejo/repository";
import * as Effect from "effect/Effect";
import * as Data from "effect/Data";
import { discovered, requireOwnership } from "./Ownership.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { listAccessibleRepositories } from "./Lists.ts";
import { replaceWhenChanged } from "./Replacement.ts";
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
const settingsOf = (
  props: BranchProtectionProps,
  observed?: ApiBranchProtection,
) => {
  // A whitelist is inert unless its enable flags are on, so declaring one
  // turns them on by default — otherwise the rule silently permits everyone.
  const hasPushWhitelist =
    (props.pushWhitelistUsernames?.length ?? 0) > 0 ||
    (props.pushWhitelistTeams?.length ?? 0) > 0;
  const whitelistDefault = hasPushWhitelist ? true : undefined;
  const managesWhitelist =
    props.enablePushWhitelist !== undefined || hasPushWhitelist;
  const enablePush =
    props.enablePush ??
    (managesWhitelist
      ? (observed?.enable_push ?? whitelistDefault ?? true)
      : undefined);
  const enablePushWhitelist =
    enablePush === false
      ? false
      : (props.enablePushWhitelist ?? whitelistDefault);
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

const edit = (props: BranchProtectionProps, observed: ApiBranchProtection) =>
  Services.repository.repoEditBranchProtection({
    ...target(props),
    name: props.ruleName,
    ...settingsOf(props, observed),
  });

export class InvalidBranchProtection extends Data.TaggedError(
  "InvalidBranchProtection",
)<{
  readonly message: string;
}> {}

/**
 * Provider layer implementing branch-protection lifecycle.
 */
export const BranchProtectionProvider = () =>
  Provider.succeed(BranchProtection, {
    stables: ["ruleName", "owner", "repository"],
    // The rule name is the endpoint's identity, alongside the repository it
    // protects, so a change to any of the three names a different rule.
    diff: replaceWhenChanged<BranchProtectionProps>(
      "owner",
      "repository",
      "ruleName",
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
    read: Effect.fn(function* ({ olds, output }) {
      const observed = yield* observe(olds);
      return observed === undefined
        ? undefined
        : discovered(attributesOf(olds, observed), output !== undefined);
    }),
    reconcile: Effect.fn(function* ({ news, output }) {
      const observed = yield* observe(news);
      if (
        news.enablePushWhitelist === true &&
        (news.enablePush ?? observed?.enable_push) === false
      ) {
        return yield* new InvalidBranchProtection({
          message: "Push whitelist enforcement requires enablePush: true.",
        });
      }
      if (observed !== undefined)
        yield* requireOwnership(output !== undefined, news.ruleName);

      if (observed === undefined) {
        const created = yield* Services.repository
          .repoCreateBranchProtection({
            ...target(news),
            rule_name: news.ruleName,
            ...settingsOf(news),
          })
          .pipe(
            // A race winner needs saved ownership; genuine permission errors survive.
            Effect.catchTag(["Forbidden", "UnprocessableEntity"], (cause) =>
              Effect.gen(function* () {
                const existing = yield* observe(news);
                if (existing === undefined) return yield* Effect.fail(cause);
                yield* requireOwnership(output !== undefined, news.ruleName);
                return yield* edit(news, existing);
              }),
            ),
          );
        return attributesOf(news, created);
      }

      // Sync only when the live rule differs from what was declared.
      const updated = matchesDesired(observed, settingsOf(news, observed))
        ? observed
        : yield* edit(news, observed);
      return attributesOf(news, updated);
    }),
    delete: Effect.fn(function* ({ output }) {
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
