import * as rulesets from "@distilled.cloud/cloudflare/rulesets";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { deepEqual, isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import type { RulesetOutputRule, RulesetPhase } from "./Ruleset.ts";

const RulesetAccountEntrypointTypeId =
  "Cloudflare.Rulesets.AccountEntrypoint" as const;
type RulesetAccountEntrypointTypeId = typeof RulesetAccountEntrypointTypeId;

/**
 * A rule inside an account phase entrypoint — same shape Cloudflare accepts
 * on the entrypoint PUT endpoint.
 */
export type AccountEntrypointRule = NonNullable<
  rulesets.PutPhasForAccountRequest["rules"]
>[number];

export type RulesetAccountEntrypointProps = {
  /**
   * Ruleset phase entrypoint to own (e.g. `http_request_firewall_custom`,
   * `ddos_l4`, `magic_transit`). Changing the phase triggers a
   * replacement. Account-level phases are Enterprise-gated — on lower
   * plans, deploys fail with the typed `PhaseNotEntitled` error.
   */
  phase: RulesetPhase;
  /**
   * The full list of rules in the phase entrypoint. This resource owns the
   * entire entrypoint — rules managed elsewhere in the same phase are
   * overwritten on deploy. For the Enterprise WAF deployment workflow, use
   * `execute` rules referencing `Cloudflare.CustomRuleset` ids.
   */
  rules: AccountEntrypointRule[];
  /**
   * Human-readable name for the entrypoint ruleset.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * An informative description of the ruleset.
   */
  description?: string;
};

export type RulesetAccountEntrypointAttributes = {
  /** The unique ID of the entrypoint ruleset (Cloudflare `id`). */
  rulesetId: string;
  /**
   * Account the phase entrypoint belongs to. Alchemy-flattened identifier —
   * not part of Cloudflare's phase-entrypoint response.
   */
  accountId: string;
  /** The kind of the ruleset (`root` for account entrypoints). */
  kind: string;
  /** The human-readable name of the ruleset. */
  name: string;
  /** The phase of the ruleset. */
  phase: RulesetPhase;
  /** An informative description of the ruleset. */
  description: string | undefined;
  /** The list of rules in the entrypoint. */
  rules: RulesetOutputRule[];
  /** The timestamp of when the ruleset was last modified. */
  lastUpdated: string;
  /** The version of the ruleset. */
  version: string;
};

export type RulesetAccountEntrypoint = Resource<
  RulesetAccountEntrypointTypeId,
  RulesetAccountEntrypointProps,
  RulesetAccountEntrypointAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare Ruleset phase entrypoint for an account.
 *
 * The account-level counterpart of `Cloudflare.Ruleset`: it owns the entire
 * ruleset for an account phase entrypoint (e.g. deploying custom WAF
 * rulesets across zones with `execute` rules, or configuring `ddos_l4` /
 * `magic_transit` rules). The entrypoint is a per-phase singleton — destroy
 * empties its rules rather than deleting the phase.
 *
 * Account-level phases require an Enterprise plan; on lower plans deploys
 * fail with the typed `PhaseNotEntitled` error.
 * @resource
 * @product Rulesets
 * @category Rules & Configuration
 * @section Account WAF Deployment
 * @example Deploy a custom ruleset across all zones
 * ```typescript
 * const ruleset = yield* Cloudflare.CustomRuleset("SharedWafRules", {
 *   phase: "http_request_firewall_custom",
 *   rules: [
 *     {
 *       description: "Block exploit probes",
 *       expression: `lower(http.request.uri.path) contains "/.env"`,
 *       action: "block",
 *     },
 *   ],
 * });
 *
 * yield* Cloudflare.RulesetAccountEntrypoint("WafDeployment", {
 *   phase: "http_request_firewall_custom",
 *   rules: [
 *     {
 *       description: "Deploy shared WAF rules",
 *       expression: "true",
 *       action: "execute",
 *       actionParameters: { id: ruleset.rulesetId },
 *     },
 *   ],
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/waf/account/
 */
export const RulesetAccountEntrypoint = Resource<RulesetAccountEntrypoint>(
  RulesetAccountEntrypointTypeId,
);

/**
 * Returns true if the given value is a RulesetAccountEntrypoint resource.
 */
export const isRulesetAccountEntrypoint = (
  value: unknown,
): value is RulesetAccountEntrypoint =>
  Predicate.hasProperty(value, "Type") &&
  value.Type === RulesetAccountEntrypointTypeId;

export const RulesetAccountEntrypointProvider = () =>
  Provider.succeed(RulesetAccountEntrypoint, {
    stables: ["rulesetId", "accountId", "kind", "phase"],

    diff: Effect.fn(function* ({ id, olds, news, output }) {
      if (!isResolved(news)) return undefined;
      // The phase is the entrypoint's identity.
      if (olds.phase !== news.phase) {
        return { action: "replace" } as const;
      }
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (output !== undefined && output.accountId !== accountId) {
        return { action: "replace" } as const;
      }
      const oldName =
        output?.name ?? olds.name ?? (yield* createPhysicalName({ id }));
      const name = news.name ?? (yield* createPhysicalName({ id }));
      if (
        oldName !== name ||
        olds.description !== news.description ||
        !deepEqual(olds.rules, news.rules)
      ) {
        return { action: "update" } as const;
      }
    }),

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Account phase entrypoints are the `root`-kind rulesets in the
      // account's ruleset list. The list response omits the rules, so
      // hydrate each entrypoint via `getPhasForAccount` (the same call
      // `read` uses) to produce the exact `read` Attributes shape.
      const entrypoints = yield* rulesets.listRulesetsForAccount
        .pages({ accountId })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk).flatMap((page) =>
              (page.result ?? []).filter((r) => r.kind === "root"),
            ),
          ),
        );
      const rows = yield* Effect.forEach(
        entrypoints,
        (entry) =>
          rulesets
            .getPhasForAccount({ accountId, rulesetPhase: entry.phase })
            .pipe(
              Effect.map((ruleset) => toAttributes(accountId, ruleset)),
              // Removed/empty out-of-band or plan-gated phases are skipped.
              Effect.catchTag("RulesetNotFound", () =>
                Effect.succeed(undefined),
              ),
              Effect.catchTag("Forbidden", () => Effect.succeed(undefined)),
            ),
        { concurrency: 10 },
      );
      return rows.filter(
        (row): row is RulesetAccountEntrypointAttributes => row !== undefined,
      );
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const accountId =
        output?.accountId ?? (yield* yield* CloudflareEnvironment).accountId;
      const phase = output?.phase ?? olds?.phase;
      if (phase === undefined) return undefined;
      // The entrypoint is a per-phase singleton that Cloudflare creates
      // lazily — there is nothing to "own", so a cold read adopts freely
      // (mirrors the zone-level `Cloudflare.Ruleset`).
      return yield* rulesets
        .getPhasForAccount({ accountId, rulesetPhase: phase })
        .pipe(
          Effect.map((ruleset) => toAttributes(accountId, ruleset)),
          Effect.catchTag("RulesetNotFound", () => Effect.succeed(undefined)),
        );
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const name =
        news.name ?? output?.name ?? (yield* createPhysicalName({ id }));
      // PUT is a true upsert on the phase entrypoint — one call observes
      // nothing and converges everything, whether the entrypoint exists yet
      // or not.
      const ruleset = yield* rulesets.putPhasForAccount({
        accountId,
        rulesetPhase: news.phase,
        name,
        description: news.description,
        rules: news.rules,
      });
      return toAttributes(accountId, ruleset);
    }),

    delete: Effect.fn(function* ({ olds, output }) {
      // The entrypoint itself is a singleton — "delete" means emptying the
      // rules we own. Idempotent: an entrypoint that never materialized (or
      // was removed out-of-band) is not an error.
      yield* rulesets
        .putPhasForAccount({
          accountId: output.accountId,
          rulesetPhase: olds.phase,
          name: output.name,
          description: output.description,
          rules: [],
        })
        .pipe(Effect.catchTag("RulesetNotFound", () => Effect.void));
    }),
  });

const toAttributes = (
  accountId: string,
  ruleset: rulesets.GetPhasResponse | rulesets.PutPhasResponse,
): RulesetAccountEntrypointAttributes => ({
  rulesetId: ruleset.id,
  accountId,
  kind: ruleset.kind,
  name: ruleset.name,
  phase: ruleset.phase,
  description: ruleset.description ?? undefined,
  rules: (ruleset.rules ?? []).map(
    ({ lastUpdated: _lastUpdated, version: _version, ...rule }) => rule,
  ),
  lastUpdated: ruleset.lastUpdated,
  version: ruleset.version,
});
