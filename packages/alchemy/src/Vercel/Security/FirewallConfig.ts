import * as security from "@distilled.cloud/vercel/security";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { VercelEnvironment } from "../VercelEnvironment.ts";

/**
 * Parameter from the incoming traffic a rule condition matches against.
 *
 * @see https://vercel.com/docs/security/vercel-waf/rule-configuration#parameters
 */
export type FirewallConditionType =
  | "host"
  | "path"
  | "method"
  | "header"
  | "query"
  | "cookie"
  | "target_path"
  | "route"
  | "raw_path"
  | "ip_address"
  | "region"
  | "protocol"
  | "scheme"
  | "environment"
  | "domain_environment"
  | "user_agent"
  | "geo_continent"
  | "geo_country"
  | "geo_country_region"
  | "geo_city"
  | "geo_as_number"
  | "ja4_digest"
  | "ja3_digest"
  | "rate_limit_api_id"
  | "server_action"
  | "bot_name"
  | "bot_category"
  | "bot_status"
  | "bot_protection"
  | "ruleset";

/**
 * Comparison operator applied to a condition's parameter.
 *
 * @see https://vercel.com/docs/security/vercel-waf/rule-configuration#operators
 */
export type FirewallConditionOp =
  | "re"
  | "eq"
  | "neq"
  | "ex"
  | "nex"
  | "inc"
  | "ninc"
  | "pre"
  | "suf"
  | "sub"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "list";

/** Mitigation applied when a custom rule matches. */
export type FirewallRuleAction =
  | "log"
  | "challenge"
  | "deny"
  | "bypass"
  | "rate_limit"
  | "redirect";

/** Action applied to traffic matching an IP blocking rule. */
export type FirewallIpAction = "deny" | "challenge" | "log" | "bypass";

/** A single match condition within a condition group. */
export interface FirewallCondition {
  /** Request parameter to match on (e.g. `path`, `header`, `ip_address`). */
  type: FirewallConditionType;
  /** Comparison operator (e.g. `eq`, `pre` for prefix, `re` for regex). */
  op: FirewallConditionOp;
  /**
   * Negate the condition.
   * @default false
   */
  neg?: boolean;
  /** Sub-key for keyed parameters (e.g. the header or query-param name). */
  key?: string;
  /** Value to compare against. */
  value?: string | string[] | number;
}

/** A group of conditions AND-ed together. Groups themselves are OR-ed. */
export interface FirewallConditionGroup {
  conditions: FirewallCondition[];
}

/** Rate-limit settings for `action: "rate_limit"` rules. */
export interface FirewallRateLimit {
  /** Rate-limiting algorithm. */
  algo: "fixed_window" | "token_bucket";
  /** Window size in seconds. */
  window: number;
  /** Maximum number of requests per window. */
  limit: number;
  /** Request properties the limit is keyed by (e.g. `["ip"]`). */
  keys: string[];
  /** Action once the limit is exceeded. */
  action?: "log" | "challenge" | "deny" | "rate_limit";
}

/** Redirect settings for `action: "redirect"` rules. */
export interface FirewallRedirect {
  location: string;
  permanent: boolean;
}

/** The mitigation a custom rule applies when its conditions match. */
export interface FirewallMitigate {
  /** Base action applied to matching traffic. */
  action: FirewallRuleAction;
  /** Rate-limit configuration (required when `action` is `rate_limit`). */
  rateLimit?: FirewallRateLimit;
  /** Redirect configuration (required when `action` is `redirect`). */
  redirect?: FirewallRedirect;
  /** Persist the action for this duration (e.g. `"1h"`) after a match. */
  actionDuration?: string;
  /** Also bypass Vercel system protections for matching traffic. */
  bypassSystem?: boolean;
}

/** A custom WAF rule. Rules are evaluated in array order. */
export interface FirewallRule {
  /** Display name of the rule. */
  name: string;
  /** Optional description. */
  description?: string;
  /**
   * Whether the rule is active.
   * @default true
   */
  active?: boolean;
  /** Condition groups — groups are OR-ed, conditions within a group AND-ed. */
  conditionGroup: FirewallConditionGroup[];
  /** Mitigation applied when the rule matches. */
  action: FirewallMitigate;
}

/** An IP blocking rule. */
export interface FirewallIpRule {
  /** Hostname the rule applies to (`*` for all hosts on the project). */
  hostname: string;
  /** IP address or CIDR block. */
  ip: string;
  /** Optional operator notes. */
  notes?: string;
  /** Action applied to matching traffic. */
  action: FirewallIpAction;
}

/** State of one OWASP Core Ruleset category. */
export interface FirewallCrsRule {
  active: boolean;
  action: "deny" | "log";
}

/**
 * OWASP Core Ruleset (managed rules) configuration. Keys are Vercel's
 * category codes: `sd` scanner detection, `ma` multipart attack, `lfi`
 * local file inclusion, `rfi` remote file inclusion, `rce` remote code
 * execution, `php` PHP attack, `gen` generic attack, `xss` XSS, `sqli`
 * SQL injection, `sf` session fixation, `java` Java attack.
 */
export interface FirewallCrs {
  sd?: FirewallCrsRule;
  ma?: FirewallCrsRule;
  lfi?: FirewallCrsRule;
  rfi?: FirewallCrsRule;
  rce?: FirewallCrsRule;
  php?: FirewallCrsRule;
  gen?: FirewallCrsRule;
  xss?: FirewallCrsRule;
  sqli?: FirewallCrsRule;
  sf?: FirewallCrsRule;
  java?: FirewallCrsRule;
}

export interface FirewallConfigProps {
  /**
   * ID of the Vercel project the firewall configuration applies to. A
   * project has exactly one firewall configuration; changing this property
   * replaces the resource (the old project's configuration is reset).
   */
  projectId: string;
  /**
   * Whether the firewall is enabled.
   * @default true
   */
  enabled?: boolean;
  /**
   * Custom WAF rules, evaluated in order. The configuration is a versioned
   * document replaced in full on every change — rules not listed here are
   * removed.
   */
  rules?: FirewallRule[];
  /**
   * IP blocking rules. Replaced in full on every change.
   */
  ips?: FirewallIpRule[];
  /**
   * OWASP Core Ruleset (managed rules) configuration. When omitted, the
   * project's existing Core Ruleset settings are left untouched.
   */
  crs?: FirewallCrs;
  /**
   * Enable Vercel BotID protection. When omitted, the existing setting is
   * left untouched.
   */
  botIdEnabled?: boolean;
}

/** Summary of a deployed custom rule (server-assigned ID included). */
export interface FirewallRuleAttribute {
  id: string;
  name: string;
  active: boolean;
}

/** Summary of a deployed IP blocking rule (server-assigned ID included). */
export interface FirewallIpAttribute {
  id: string;
  hostname: string;
  ip: string;
  notes?: string;
  action: FirewallIpAction;
}

export type FirewallConfig = Resource<
  "Vercel.FirewallConfig",
  FirewallConfigProps,
  {
    /** ID of the project the configuration is attached to. */
    projectId: string;
    /** Owner (team/user) ID reported by the API. */
    ownerId: string;
    /** Server-assigned ID of the active configuration document. */
    configId: string;
    /**
     * Version of the active configuration document. Increments on every
     * change (including out-of-band edits in the dashboard).
     */
    version: number;
    /** ISO timestamp of the last configuration change. */
    updatedAt: string;
    /** Whether the firewall is enabled. */
    firewallEnabled: boolean;
    /** Deployed custom rules with their server-assigned IDs. */
    rules: FirewallRuleAttribute[];
    /** Deployed IP blocking rules with their server-assigned IDs. */
    ips: FirewallIpAttribute[];
  },
  never,
  Providers
>;

type FirewallConfigAttributes = FirewallConfig["Attributes"];

/**
 * The Vercel WAF (firewall) configuration of a project.
 *
 * The firewall configuration is a versioned singleton document per project:
 * every change PUTs the full desired document and the platform increments
 * the `version`. The provider reconciles by diffing the observed active
 * configuration against the desired document and only writes on a delta.
 *
 * Deleting the resource resets the project's firewall to an empty, disabled
 * configuration (the API's DELETE endpoint targets draft config versions,
 * not the active document, so a full PUT of the empty document is the reset
 * primitive).
 *
 * @resource
 * @section Creating a Firewall Configuration
 * @example Deny traffic to a path
 * ```typescript
 * const waf = yield* Vercel.FirewallConfig("Waf", {
 *   projectId: project.projectId,
 *   rules: [
 *     {
 *       name: "block-admin",
 *       conditionGroup: [
 *         { conditions: [{ type: "path", op: "pre", value: "/admin" }] },
 *       ],
 *       action: { action: "deny" },
 *     },
 *   ],
 * });
 * ```
 *
 * @example Challenge suspicious traffic
 * ```typescript
 * const waf = yield* Vercel.FirewallConfig("Waf", {
 *   projectId: project.projectId,
 *   rules: [
 *     {
 *       name: "challenge-bots",
 *       description: "Interstitial challenge for unknown bots",
 *       conditionGroup: [
 *         { conditions: [{ type: "bot_status", op: "eq", value: "unverified" }] },
 *       ],
 *       action: { action: "challenge" },
 *     },
 *   ],
 * });
 * ```
 *
 * @section IP Blocking
 * @example Deny a CIDR block on every host
 * ```typescript
 * const waf = yield* Vercel.FirewallConfig("Waf", {
 *   projectId: project.projectId,
 *   ips: [{ hostname: "*", ip: "203.0.113.0/24", action: "deny" }],
 * });
 * ```
 *
 * @section Managed Rulesets
 * @example Enable OWASP Core Ruleset categories
 * ```typescript
 * const waf = yield* Vercel.FirewallConfig("Waf", {
 *   projectId: project.projectId,
 *   crs: {
 *     sqli: { active: true, action: "deny" },
 *     xss: { active: true, action: "deny" },
 *   },
 * });
 * ```
 *
 * @section Rate Limiting
 * @example Rate limit an API route by IP
 * ```typescript
 * const waf = yield* Vercel.FirewallConfig("Waf", {
 *   projectId: project.projectId,
 *   rules: [
 *     {
 *       name: "api-rate-limit",
 *       conditionGroup: [
 *         { conditions: [{ type: "path", op: "pre", value: "/api" }] },
 *       ],
 *       action: {
 *         action: "rate_limit",
 *         rateLimit: {
 *           algo: "fixed_window",
 *           window: 60,
 *           limit: 100,
 *           keys: ["ip"],
 *           action: "deny",
 *         },
 *       },
 *     },
 *   ],
 * });
 * ```
 *
 * @see https://vercel.com/docs/security/vercel-waf
 */
export const FirewallConfig = Resource<FirewallConfig>("Vercel.FirewallConfig");

export const FirewallConfigProvider = () =>
  Provider.succeed(FirewallConfig, {
    stables: ["projectId", "ownerId", "configId"],
    diff: Effect.fn(function* ({ olds, news, output }) {
      if (!isResolved(news)) return undefined;
      const oldProjectId = output?.projectId ?? olds?.projectId;
      if (oldProjectId !== undefined && news.projectId !== oldProjectId) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ olds, output }) {
      const projectId = output?.projectId ?? olds?.projectId;
      if (projectId === undefined) return undefined;
      const { teamId } = yield* VercelEnvironment.current;
      return yield* security
        .getFirewallConfig({ configVersion: "active", projectId, teamId })
        .pipe(
          Effect.map((doc) => toAttributes(projectId, doc)),
          // NotFound covers both "project gone" and "no firewall
          // configuration has ever been written for this project".
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
    }),
    reconcile: Effect.fn(function* ({ news }) {
      const { teamId } = yield* VercelEnvironment.current;
      const projectId = news.projectId;
      // Observe — the active configuration document is the source of truth.
      const observed = yield* security
        .getFirewallConfig({ configVersion: "active", projectId, teamId })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      // Sync — the whole document is the reconcile unit: diff observed vs
      // desired and PUT the full replacement only on a delta.
      if (observed !== undefined && matchesDesired(news, observed)) {
        return toAttributes(projectId, observed);
      }
      const result = yield* security.putFirewallConfig({
        projectId,
        teamId,
        firewallEnabled: news.enabled ?? true,
        rules: (news.rules ?? []).map(toRequestRule),
        ips: (news.ips ?? []).map((ip) => ({
          hostname: ip.hostname,
          ip: ip.ip,
          notes: ip.notes,
          action: ip.action,
        })),
        crs: news.crs,
        botIdEnabled: news.botIdEnabled,
      });
      return toAttributes(projectId, result.active);
    }),
    delete: Effect.fn(function* ({ output }) {
      const { teamId } = yield* VercelEnvironment.current;
      // The DELETE /v1/security/firewall/config/{configVersion} endpoint
      // targets draft config versions (and its spec carries no projectId),
      // so resetting the active document to empty+disabled via a full PUT
      // is the delete primitive. Idempotent: PUT of the empty document
      // converges regardless of prior state; a deleted host project
      // surfaces as NotFound and is not an error.
      yield* security
        .putFirewallConfig({
          projectId: output.projectId,
          teamId,
          firewallEnabled: false,
          rules: [],
          ips: [],
        })
        .pipe(
          Effect.asVoid,
          Effect.catchTag("NotFound", () => Effect.void),
        );
    }),
  });

// ─────────────────────────────────────────────────────────────────────────────
// Document mapping & comparison helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Structural view of the active firewall configuration document. Both
 * `GetFirewallConfigResponse` and `PutFirewallConfigResponse["active"]`
 * satisfy this shape, so every helper below works on either without
 * union-typed member access.
 */
interface RawCondition {
  readonly type: string;
  readonly op: string;
  readonly neg?: boolean;
  readonly key?: string;
  readonly value?: unknown;
}

interface RawMitigate {
  readonly action?: string;
  readonly rateLimit?: unknown;
  readonly redirect?: unknown;
  readonly actionDuration?: string | null;
  readonly bypassSystem?: boolean | null;
}

interface RawRule {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly active: boolean;
  readonly conditionGroup: ReadonlyArray<{
    readonly conditions: ReadonlyArray<RawCondition>;
  }>;
  readonly action: { readonly mitigate?: RawMitigate };
}

interface RawIp {
  readonly id: string;
  readonly hostname: string;
  readonly ip: string;
  readonly notes?: string;
  readonly action: string;
}

interface RawDocument {
  readonly ownerId: string;
  readonly id: string;
  readonly version: number;
  readonly updatedAt: string;
  readonly firewallEnabled: boolean;
  readonly rules: ReadonlyArray<RawRule>;
  readonly ips: ReadonlyArray<RawIp>;
  readonly crs?: unknown;
  readonly botIdEnabled?: boolean;
}

const toRequestRule = (
  rule: FirewallRule,
): security.PutFirewallConfigRequestRulesItem => ({
  name: rule.name,
  description: rule.description,
  active: rule.active ?? true,
  conditionGroup: rule.conditionGroup.map((group) => ({
    conditions: group.conditions.map((condition) => ({
      type: condition.type,
      op: condition.op,
      neg: condition.neg,
      key: condition.key,
      value: condition.value,
    })),
  })),
  action: {
    mitigate: {
      action: rule.action.action,
      rateLimit: rule.action.rateLimit,
      redirect: rule.action.redirect,
      actionDuration: rule.action.actionDuration,
      bypassSystem: rule.action.bypassSystem,
    },
  },
});

const toAttributes = (
  projectId: string,
  doc: RawDocument,
): FirewallConfigAttributes => ({
  projectId,
  ownerId: doc.ownerId,
  configId: doc.id,
  version: doc.version,
  updatedAt: doc.updatedAt,
  firewallEnabled: doc.firewallEnabled,
  rules: doc.rules.map((rule) => ({
    id: rule.id,
    name: rule.name,
    active: rule.active,
  })),
  ips: doc.ips.map((ip) => ({
    id: ip.id,
    hostname: ip.hostname,
    ip: ip.ip,
    ...(ip.notes !== undefined ? { notes: ip.notes } : {}),
    action: ip.action as FirewallIpAction,
  })),
});

/**
 * Deterministic stringify: object keys sorted, `undefined`/`null` members
 * dropped, arrays kept in order — so a server-echoed document (arbitrary
 * key order, explicit `null`s) compares equal to our desired literal.
 */
const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined && v !== null)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
};

interface CanonicalRule {
  name: string;
  description?: string;
  active: boolean;
  conditionGroup: {
    conditions: {
      type: string;
      op: string;
      neg?: boolean;
      key?: string;
      value?: unknown;
    }[];
  }[];
  action: {
    action?: string;
    rateLimit?: unknown;
    redirect?: unknown;
    actionDuration?: string;
    bypassSystem?: boolean;
  };
}

const canonicalRuleFromProps = (rule: FirewallRule): CanonicalRule => ({
  name: rule.name,
  description: emptyToUndefined(rule.description),
  active: rule.active ?? true,
  conditionGroup: rule.conditionGroup.map((group) => ({
    conditions: group.conditions.map((condition) => ({
      type: condition.type,
      op: condition.op,
      neg: condition.neg === true ? true : undefined,
      key: emptyToUndefined(condition.key),
      value: condition.value,
    })),
  })),
  action: {
    action: rule.action.action,
    rateLimit: rule.action.rateLimit,
    redirect: rule.action.redirect,
    actionDuration: rule.action.actionDuration ?? undefined,
    bypassSystem: rule.action.bypassSystem === true ? true : undefined,
  },
});

const canonicalRuleFromObserved = (rule: RawRule): CanonicalRule => ({
  name: rule.name,
  description: emptyToUndefined(rule.description),
  active: rule.active,
  conditionGroup: rule.conditionGroup.map((group) => ({
    conditions: group.conditions.map((condition) => ({
      type: condition.type,
      op: condition.op,
      neg: condition.neg === true ? true : undefined,
      key: emptyToUndefined(condition.key),
      value: condition.value,
    })),
  })),
  action: {
    action: rule.action.mitigate?.action,
    rateLimit: rule.action.mitigate?.rateLimit ?? undefined,
    redirect: rule.action.mitigate?.redirect ?? undefined,
    actionDuration: rule.action.mitigate?.actionDuration ?? undefined,
    bypassSystem:
      rule.action.mitigate?.bypassSystem === true ? true : undefined,
  },
});

const canonicalIp = (ip: {
  hostname: string;
  ip: string;
  notes?: string;
  action: string;
}) => ({
  hostname: ip.hostname,
  ip: ip.ip,
  notes: emptyToUndefined(ip.notes),
  action: ip.action,
});

const CRS_KEYS = [
  "sd",
  "ma",
  "lfi",
  "rfi",
  "rce",
  "php",
  "gen",
  "xss",
  "sqli",
  "sf",
  "java",
] as const;

const canonicalCrs = (crs: FirewallCrs | undefined) =>
  CRS_KEYS.map((key) => {
    const entry = crs?.[key];
    return entry === undefined
      ? undefined
      : { key, active: entry.active, action: entry.action };
  }).filter((entry) => entry !== undefined);

const emptyToUndefined = (value: string | undefined): string | undefined =>
  value === undefined || value === "" ? undefined : value;

/**
 * Compare the desired document (from props) against the observed active
 * configuration. `crs` and `botIdEnabled` participate only when the user
 * declared them — omitted means "leave the platform setting untouched".
 */
const matchesDesired = (
  news: FirewallConfigProps,
  observed: RawDocument,
): boolean => {
  if ((news.enabled ?? true) !== observed.firewallEnabled) return false;
  const desiredRules = (news.rules ?? []).map(canonicalRuleFromProps);
  const observedRules = observed.rules.map(canonicalRuleFromObserved);
  if (stableStringify(desiredRules) !== stableStringify(observedRules)) {
    return false;
  }
  const desiredIps = (news.ips ?? []).map(canonicalIp);
  const observedIps = observed.ips.map((ip) => canonicalIp(ip));
  if (stableStringify(desiredIps) !== stableStringify(observedIps)) {
    return false;
  }
  if (news.crs !== undefined) {
    if (
      stableStringify(canonicalCrs(news.crs)) !==
      stableStringify(canonicalCrs(observed.crs as FirewallCrs | undefined))
    ) {
      return false;
    }
  }
  if (news.botIdEnabled !== undefined) {
    if (news.botIdEnabled !== (observed.botIdEnabled ?? false)) return false;
  }
  return true;
};
