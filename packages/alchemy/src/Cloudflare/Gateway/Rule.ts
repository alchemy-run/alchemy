import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { arrayEquals } from "../../Util/equal.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

/**
 * Action Cloudflare Gateway takes when a rule's traffic/identity/device-posture
 * expressions match. Mirrors the open-ended literal union distilled exposes so
 * unknown values flowing back from Cloudflare narrow cleanly.
 */
export type GatewayRuleAction =
  | "on"
  | "off"
  | "allow"
  | "block"
  | "scan"
  | "noscan"
  | "safesearch"
  | "ytrestricted"
  | "isolate"
  | "noisolate"
  | "override"
  | "l4_override"
  | "egress"
  | "resolve"
  | "quarantine"
  | "redirect"
  | (string & {});

/**
 * Filter Cloudflare Gateway evaluates the rule against. Selects the layer the
 * `traffic` expression operates on — DNS, HTTP, raw L4, the egress path, or
 * the `dns_resolver` plane (which is what private-app destinations use when
 * Gateway needs to override the answer for an internal hostname).
 */
export type GatewayRuleFilter =
  | "http"
  | "dns"
  | "l4"
  | "egress"
  | "dns_resolver"
  | (string & {});

/**
 * Settings the rule applies when it matches. Re-exports distilled's request
 * shape so every server-recognised knob (override host, block page, DNS
 * resolvers, BISO controls, egress IPs, redirect target, …) is available
 * without re-declaring the structure.
 *
 * Only a subset is meaningful for any given `action`; consult Cloudflare's
 * Gateway rule docs for which settings apply per action.
 */
export type GatewayRuleSettings = NonNullable<
  zeroTrust.CreateGatewayRuleRequest["ruleSettings"]
>;

export interface GatewayRuleProps {
  /**
   * Human-readable rule name. If omitted, a deterministic physical name is
   * generated from the app/stage/logical-id. Used during adoption to locate
   * an existing rule by name when no `ruleId` is cached.
   */
  name?: string;
  /**
   * Action Cloudflare Gateway takes when the rule matches. Stable across
   * reconciles; changing it triggers a replacement so a rule never silently
   * flips semantics under existing references.
   */
  action: GatewayRuleAction;
  /**
   * Protocol/layer the rule's `traffic` expression evaluates against.
   * Cloudflare currently accepts a single filter per rule; the SDK still
   * types it as an array to mirror the wire shape.
   */
  filters: ReadonlyArray<GatewayRuleFilter>;
  /**
   * Wirefilter expression used for traffic matching. Cloudflare auto-formats
   * and sanitises this server-side — to avoid perpetual diffs, prefer the
   * formatted form (e.g. `'any(dns.domains[*] == "internal.example")'`).
   */
  traffic?: string;
  /**
   * Wirefilter expression used for identity matching (group memberships,
   * email, IdP attrs). Combined with `traffic` and `devicePosture` via
   * logical AND.
   */
  identity?: string;
  /**
   * Wirefilter expression used for device-posture matching (WARP, MDM, etc).
   */
  devicePosture?: string;
  /**
   * Per-action settings applied when the rule matches. The most common
   * private-app use case sets `overrideHost` to a `${tunnelId}.cfargotunnel.com`
   * to point intercepted DNS at a Cloudflare Tunnel.
   *
   * @example
   * ```ts
   * ruleSettings: {
   *   overrideHost: `${tunnelId}.cfargotunnel.com`,
   * }
   * ```
   */
  ruleSettings?: GatewayRuleSettings;
  /**
   * Rule precedence — lower values evaluate first. When unset, Cloudflare
   * picks one server-side; we then echo whatever it assigned back through
   * the output attributes.
   */
  precedence?: number;
  /**
   * Whether the rule is enabled.
   *
   * @default true
   */
  enabled?: boolean;
  /**
   * Free-form description.
   */
  description?: string;
  /**
   * Adopt an existing rule with the same name (matched during the list-scan
   * fallback when no `ruleId` is cached) instead of failing on conflict.
   *
   * @default false
   */
  adopt?: boolean;
}

export interface GatewayRuleAttributes {
  /** Cloudflare-assigned rule UUID. */
  ruleId: string;
  /** Resolved display name (server-side). */
  name: string;
  /** Resolved action. */
  action: GatewayRuleAction;
  /** Resolved filters. */
  filters: ReadonlyArray<GatewayRuleFilter>;
  /** Server-assigned precedence (always populated on the response). */
  precedence: number;
  /** Account that owns this rule. */
  accountId: string;
  /** ISO8601 creation timestamp. */
  createdAt: string | undefined;
  /** ISO8601 last-update timestamp. */
  updatedAt: string | undefined;
}

export type GatewayRule = Resource<
  "Cloudflare.Gateway.Rule",
  GatewayRuleProps,
  GatewayRuleAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare Zero Trust Gateway rule.
 *
 * Gateway rules sit on the WARP/Gateway data plane and run *before* Access:
 * they decide whether to allow, block, override, isolate, or redirect a
 * request based on wirefilter expressions over the request traffic,
 * the authenticated identity, and the device posture. The most common
 * companion to {@link AccessApplication} with a `private` destination is a
 * `dns` rule with `action: "override"` that points an internal hostname at
 * a Cloudflare Tunnel — without it, WARP intercepts the lookup but has
 * nowhere to send the answer.
 * @resource
 * @product Gateway
 * @category Cloudflare One (Zero Trust)
 * @section DNS override for a private app
 * @example Resolve an internal hostname through a Cloudflare Tunnel
 * ```typescript
 * const adminDns = yield* Cloudflare.GatewayRule("AdminMicroagiDns", {
 *   name: "research-admin-microagi-dns-override",
 *   action: "override",
 *   filters: ["dns"],
 *   traffic: 'any(dns.domains[*] == "cluster-admin.microagi")',
 *   ruleSettings: {
 *     overrideHost: `${tunnel.tunnelId}.cfargotunnel.com`,
 *   },
 *   enabled: true,
 * });
 * ```
 *
 * @section Block a category
 * @example Block known phishing on HTTP
 * ```typescript
 * yield* Cloudflare.GatewayRule("BlockPhishing", {
 *   name: "block-phishing",
 *   action: "block",
 *   filters: ["http"],
 *   traffic: "any(http.request.uri.content_category[*] in {178})",
 * });
 * ```
 */
export const GatewayRule = Resource<GatewayRule>("Cloudflare.Gateway.Rule");

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const GatewayRuleProvider = () =>
  Provider.effect(
    GatewayRule,
    Effect.gen(function* () {
      const env = yield* CloudflareEnvironment;

      const createRule = yield* zeroTrust.createGatewayRule;
      const getRule = yield* zeroTrust.getGatewayRule;
      const updateRule = yield* zeroTrust.updateGatewayRule;
      const deleteRule = yield* zeroTrust.deleteGatewayRule;
      const listRules = zeroTrust.listGatewayRules;

      const resolveName = (id: string, name: string | undefined) =>
        Effect.gen(function* () {
          if (name) return name;
          return yield* createPhysicalName({ id });
        });

      // Locate an existing rule by name when no ruleId is cached — used for
      // adoption and as a recovery path after a create returns a conflict.
      const findRuleByName = (accountId: string, name: string) =>
        listRules.items({ accountId }).pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk).find(
              (r) => (r as { name?: string | null }).name === name,
            ),
          ),
          Effect.map((found) =>
            found === undefined
              ? undefined
              : narrowRule(found as Parameters<typeof narrowRule>[0]),
          ),
        );

      const observeById = (accountId: string, ruleId: string) =>
        Effect.gen(function* () {
          const r = yield* getRule({ accountId, ruleId }).pipe(
            // Distilled tags transport errors but not the live Cloudflare 404
            // for a missing rule. Swallow generically so the reconcile flow
            // falls through to recreate.
            Effect.catch(() => Effect.succeed(undefined)),
          );
          if (r === undefined) return undefined;
          return narrowRule(r as Parameters<typeof narrowRule>[0]);
        });

      return {
        stables: ["ruleId", "action", "accountId"],

        // Account collection (pattern b): Gateway rules are account-scoped
        // (`/accounts/{id}/gateway/rules`). Exhaustively page the list op,
        // narrow each rule, and hydrate the exact `read` Attributes shape.
        // Rules missing a required field (id/action/filters/precedence) are
        // dropped rather than surfaced as partial rows.
        list: () =>
          Effect.gen(function* () {
            const { accountId } = yield* env;
            return yield* listRules.pages({ accountId }).pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) =>
                  (page.result ?? []).flatMap((raw) => {
                    const r = narrowRule(
                      raw as Parameters<typeof narrowRule>[0],
                    );
                    if (
                      !r.id ||
                      !r.action ||
                      !r.filters ||
                      r.precedence === undefined
                    ) {
                      return [];
                    }
                    return [
                      {
                        ruleId: r.id,
                        name: r.name ?? r.id,
                        action: r.action,
                        filters: r.filters,
                        precedence: r.precedence,
                        accountId,
                        createdAt: r.createdAt,
                        updatedAt: r.updatedAt,
                      } satisfies GatewayRuleAttributes,
                    ];
                  }),
                ),
              ),
            );
          }),

        diff: Effect.fn(function* ({ olds = {}, news }) {
          if ((olds as GatewayRuleProps).action !== undefined) {
            if (
              (olds as GatewayRuleProps).action !==
              (news as GatewayRuleProps).action
            ) {
              return { action: "replace" } as const;
            }
          }
        }),

        reconcile: Effect.fn(function* ({ id, news, output }) {
          const { accountId } = yield* env;
          const resolvedName = yield* resolveName(id, news.name);
          const body = buildMutableBody(news, resolvedName);

          // 1. Observe
          let observed: ObservedRule | undefined;
          if (output?.ruleId) {
            observed = yield* observeById(accountId, output.ruleId);
          }
          if (!observed) {
            // Adoption / recovery path — look up by name. Cheap relative to
            // the create call we'd otherwise blow up on a duplicate name.
            observed = yield* findRuleByName(accountId, resolvedName);
          }

          // 2. Ensure
          if (!observed) {
            const created = yield* createRule({
              accountId,
              name: resolvedName,
              action: body.action,
              filters: Array.from(body.filters),
              traffic: body.traffic,
              identity: body.identity,
              devicePosture: body.devicePosture,
              ruleSettings: body.ruleSettings,
              precedence: body.precedence,
              enabled: body.enabled,
              description: body.description,
            }).pipe(
              // Distilled does not tag Conflict — fall back to a name lookup
              // before re-failing so a racing create still converges.
              Effect.catch((err) =>
                Effect.gen(function* () {
                  const existing = yield* findRuleByName(
                    accountId,
                    resolvedName,
                  );
                  if (existing) return existing;
                  return yield* Effect.fail(err);
                }),
              ),
            );
            observed = narrowRule(created as Parameters<typeof narrowRule>[0]);
          }

          // 3. Sync
          if (!observed.id) {
            return yield* Effect.fail(
              new Error("Cloudflare did not return a rule id for Gateway rule"),
            );
          }
          if (!bodyEqualsObserved(body, observed)) {
            const updated = yield* updateRule({
              accountId,
              ruleId: observed.id,
              name: resolvedName,
              action: body.action,
              filters: Array.from(body.filters),
              traffic: body.traffic,
              identity: body.identity,
              devicePosture: body.devicePosture,
              ruleSettings: body.ruleSettings,
              precedence: body.precedence,
              enabled: body.enabled,
              description: body.description,
            });
            observed = narrowRule(updated as Parameters<typeof narrowRule>[0]);
          }

          // 4. Return
          if (
            !observed.id ||
            !observed.action ||
            !observed.filters ||
            observed.precedence === undefined
          ) {
            return yield* Effect.fail(
              new Error(
                "Cloudflare returned a Gateway rule without id/action/filters/precedence",
              ),
            );
          }
          return {
            ruleId: observed.id,
            name: observed.name ?? resolvedName,
            action: observed.action,
            filters: observed.filters,
            precedence: observed.precedence,
            accountId,
            createdAt: observed.createdAt,
            updatedAt: observed.updatedAt,
          } satisfies GatewayRuleAttributes;
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* deleteRule({
            accountId: output.accountId,
            ruleId: output.ruleId,
          }).pipe(Effect.catch(() => Effect.void));
        }),

        read: Effect.fn(function* ({ output }) {
          if (!output?.ruleId) return undefined;
          const observed = yield* observeById(output.accountId, output.ruleId);
          if (
            !observed?.id ||
            !observed.action ||
            !observed.filters ||
            observed.precedence === undefined
          ) {
            return undefined;
          }
          return {
            ruleId: observed.id,
            name: observed.name ?? output.name,
            action: observed.action,
            filters: observed.filters,
            precedence: observed.precedence,
            accountId: output.accountId,
            createdAt: observed.createdAt ?? output.createdAt,
            updatedAt: observed.updatedAt ?? output.updatedAt,
          } satisfies GatewayRuleAttributes;
        }),
      };
    }),
  );

interface ObservedRule {
  readonly id?: string;
  readonly name?: string;
  readonly action?: GatewayRuleAction;
  readonly filters?: ReadonlyArray<GatewayRuleFilter>;
  readonly traffic?: string;
  readonly identity?: string;
  readonly devicePosture?: string;
  readonly precedence?: number;
  readonly enabled?: boolean;
  readonly description?: string;
  readonly ruleSettings?: Record<string, unknown>;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

const undef = <T>(v: T | null | undefined): T | undefined =>
  v == null ? undefined : v;

const undefArr = <T>(
  v: ReadonlyArray<T | null> | null | undefined,
): ReadonlyArray<T> | undefined =>
  v == null ? undefined : (v.filter((x) => x != null) as ReadonlyArray<T>);

const narrowRule = (raw: {
  id?: string | null;
  name?: string | null;
  action?: GatewayRuleAction | null | string;
  filters?: ReadonlyArray<GatewayRuleFilter | null> | null;
  traffic?: string | null;
  identity?: string | null;
  devicePosture?: string | null;
  precedence?: number | null;
  enabled?: boolean | null;
  description?: string | null;
  ruleSettings?: Record<string, unknown> | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}): ObservedRule => ({
  id: undef(raw.id),
  name: undef(raw.name),
  action: raw.action == null ? undefined : (raw.action as GatewayRuleAction),
  filters: undefArr(raw.filters ?? undefined),
  traffic: undef(raw.traffic),
  identity: undef(raw.identity),
  devicePosture: undef(raw.devicePosture),
  precedence: undef(raw.precedence),
  enabled: undef(raw.enabled),
  description: undef(raw.description),
  ruleSettings: undef(raw.ruleSettings),
  createdAt: undef(raw.createdAt),
  updatedAt: undef(raw.updatedAt),
});

// ---------------------------------------------------------------------------
// Body construction
// ---------------------------------------------------------------------------

interface RuleMutableBody {
  name: string;
  action: GatewayRuleAction;
  filters: ReadonlyArray<GatewayRuleFilter>;
  traffic?: string;
  identity?: string;
  devicePosture?: string;
  ruleSettings?: GatewayRuleSettings;
  precedence?: number;
  enabled?: boolean;
  description?: string;
}

const buildMutableBody = (
  news: GatewayRuleProps,
  resolvedName: string,
): RuleMutableBody => {
  const body: RuleMutableBody = {
    name: resolvedName,
    action: news.action,
    filters: news.filters,
  };
  if (news.traffic !== undefined) body.traffic = news.traffic;
  if (news.identity !== undefined) body.identity = news.identity;
  if (news.devicePosture !== undefined) body.devicePosture = news.devicePosture;
  if (news.ruleSettings !== undefined) body.ruleSettings = news.ruleSettings;
  if (news.precedence !== undefined) body.precedence = news.precedence;
  if (news.enabled !== undefined) body.enabled = news.enabled;
  if (news.description !== undefined) body.description = news.description;
  return body;
};

// ---------------------------------------------------------------------------
// Drift detection
// ---------------------------------------------------------------------------

const bodyEqualsObserved = (
  desired: RuleMutableBody,
  observed: ObservedRule,
): boolean => {
  if (desired.name !== observed.name) return false;
  if (desired.action !== observed.action) return false;
  if (!arrayEquals(desired.filters, observed.filters)) return false;
  if (desired.traffic !== undefined && desired.traffic !== observed.traffic) {
    return false;
  }
  if (
    desired.identity !== undefined &&
    desired.identity !== observed.identity
  ) {
    return false;
  }
  if (
    desired.devicePosture !== undefined &&
    desired.devicePosture !== observed.devicePosture
  ) {
    return false;
  }
  if (
    desired.precedence !== undefined &&
    desired.precedence !== observed.precedence
  ) {
    return false;
  }
  if (desired.enabled !== undefined && desired.enabled !== observed.enabled) {
    return false;
  }
  if (
    desired.description !== undefined &&
    desired.description !== observed.description
  ) {
    return false;
  }
  // ruleSettings is a deeply-nested object whose server echo may include
  // extra `null` fields. Stringify-compare only when the caller set them.
  if (desired.ruleSettings !== undefined) {
    if (
      JSON.stringify(desired.ruleSettings) !==
      JSON.stringify(observed.ruleSettings ?? {})
    ) {
      return false;
    }
  }
  return true;
};
