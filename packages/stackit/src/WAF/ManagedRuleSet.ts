import * as waf from "@distilled.cloud/stackit/alb_waf";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { StackitEnvironment } from "../Environment.ts";
import {
  projectScopeChanged,
  resolveProjectScope,
  type ProjectScope,
  type ProjectScopedProps,
} from "../IaaS/internal.ts";
import { hasUnresolvedTrigger, rawProp, triggerProps } from "../internal/diff.ts";
import { ensureServiceEnabled } from "../internal/enable.ts";
import { isGeneratedPhysicalName } from "../internal/names.ts";
import { retryWhileInUse } from "../internal/wait.ts";
import {
  LOAD_BALANCER_SERVICE_ID,
  NAME_MAX_LENGTH,
  physicalName,
} from "../LoadBalancer/internal.ts";
import type { Providers } from "../Providers.ts";
import { getManagedRuleSetOrUndefined, listAllManagedRuleSets } from "./internal.ts";

const DEFAULT_TYPE = "TYPE_OWASP_CRS";

/** The modes of a rule group's rules, by rule id. */
export interface ManagedRuleGroupOverride {
  /** The rules to set, by rule id. Other rules of the group are left alone. */
  rules: Record<string, { mode: waf.Mode }>;
}

export interface ManagedRuleSetProps extends ProjectScopedProps {
  /**
   * Name of the rule set, the API's key for it: 1-63 characters of `[0-9a-z-]`.
   * Changing it replaces the rule set.
   * @default a physical name generated from the app, stage and logical id
   */
  name?: string;
  /**
   * Which managed rules to use. `TYPE_OWASP_CRS` is the only type today. Changing
   * it replaces the rule set.
   * @default "TYPE_OWASP_CRS"
   */
  type?: waf.Type;
  /**
   * Rules to set to another mode, by group id (e.g. `"942"` for SQL injection)
   * and rule id. Rules you don't list keep the mode they have. Updated in place.
   * Removing a rule from here restores the mode Alchemy saw on it before it first
   * set one.
   */
  groups?: Record<string, ManagedRuleGroupOverride>;
}

export interface ManagedRuleSetAttributes {
  /** Name of the rule set, which a `Configuration` takes as `managedRuleSetName`. */
  ruleSetName: string;
  /** Project of the rule set. */
  projectId: string;
  /** Region of the rule set. */
  region: string;
  /** Which managed rules it uses. */
  type: waf.Type;
  /** Version of the managed rules. */
  version: string;
  /**
   * The inventory of rule groups and their rules' current modes, by group id.
   * `undefined` on a rule set enumerated by `alchemy unsafe nuke`.
   */
  groups: waf.GetManagedRuleSetResponseGroupsMap | undefined;
  /** The WAF configurations using it when last read. */
  usage: waf.MRSUsage | undefined;
  /** The mode each overridden rule had before Alchemy first set it, by group and rule id. */
  originalModes: Record<string, Record<string, waf.Mode>>;
}

export type ManagedRuleSet = Resource<
  "Stackit.WAF.ManagedRuleSet",
  ManagedRuleSetProps,
  ManagedRuleSetAttributes,
  never,
  Providers
>;

/**
 * A STACKIT web application firewall managed rule set: the OWASP Core Rule Set,
 * which a `Stackit.WAF.Configuration` applies through `managedRuleSetName`. The
 * attribute `groups` lists every rule with its current mode.
 *
 * Rule modes update in place, and only the rules whose mode differs are sent. A
 * new name, scope or type replaces the rule set. The first deploy also enables
 * the service (`cloud.stackit.loadbalancer`) for the project. STACKIT refuses to
 * delete a rule set a configuration still uses; a delete retries for about a
 * minute, then fails with the API's `BadRequest`.
 *
 * Ownership: rule sets have no labels, so the name in Alchemy's state is the
 * identity. A rule set of an explicit name that Alchemy didn't record is reported
 * as unowned and only taken over with `--adopt`. `alchemy unsafe nuke` only
 * clears rule sets with the shape of a generated physical name, so choose a name
 * outside that shape for a rule set that must survive a nuke.
 *
 * See [STACKIT's ALB WAF docs](https://docs.stackit.cloud/products/network/load-balancing-and-content-delivery/application-load-balancer/basics/basic-concepts-alb-waf/).
 *
 * :::caution[Changing `name`, `type`, `projectId` or `region` replaces the Rule Set]
 * STACKIT refuses to delete a rule set a configuration still uses: a delete retries
 * for about a minute, then fails with the API's `BadRequest`. Rule modes update in
 * place.
 * :::
 *
 * ### Creating a Rule Set
 * **Example:** The OWASP Core Rule Set with its default modes
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const rules = yield* Stackit.WAF.ManagedRuleSet("Owasp", {});
 * const firewall = yield* Stackit.WAF.Configuration("Firewall", {
 *   managedRuleSetName: rules.ruleSetName,
 * });
 * ```
 *
 * ### Tuning Rules
 * **Example:** Log one rule and disable another
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const rules = yield* Stackit.WAF.ManagedRuleSet("Owasp", {
 *   groups: {
 *     "942": {
 *       rules: {
 *         "942100": { mode: "MODE_LOG_ONLY" },
 *         "942200": { mode: "MODE_DISABLED" },
 *       },
 *     },
 *   },
 * });
 * ```
 *
 * ### Runtime Operations
 * **Example:** Switch a rule to log-only from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Owasp = Stackit.WAF.ManagedRuleSet("Owasp", {});
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const patchRules = yield* Stackit.WAF.PatchManagedRuleSet(yield* Owasp);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* patchRules({
 *           groups: { "942": { rules: { "942100": { mode: "MODE_LOG_ONLY" } } } },
 *         });
 *         return HttpServerResponse.text("patched");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.WAF.PatchManagedRuleSetHttp)),
 * ) {}
 * ```
 *
 * ### Replacement Cautions
 * **Example:** Renaming a rule set a configuration uses
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * // A new name creates the new rule set first, the configuration moves to it,
 * // and the old rule set is deleted. Its overrides are applied to the new one.
 * const rules = yield* Stackit.WAF.ManagedRuleSet("Owasp", {
 *   name: "owasp-v2",
 * });
 * const firewall = yield* Stackit.WAF.Configuration("Firewall", {
 *   managedRuleSetName: rules.ruleSetName,
 * });
 * ```
 *
 * @resource
 * @product STACKIT ALB Web Application Firewall
 * @category WAF
 */
export const ManagedRuleSet = Resource<ManagedRuleSet>("Stackit.WAF.ManagedRuleSet");

const toAttrs = (
  scope: ProjectScope,
  ruleSet: waf.GetManagedRuleSetResponse | waf.GetLimitedManagedRuleSetResponse,
  originalModes: Record<string, Record<string, waf.Mode>>,
): ManagedRuleSetAttributes => ({
  ruleSetName: ruleSet.name,
  ...scope,
  type: ruleSet.type,
  version: ruleSet.version,
  groups: "groups" in ruleSet ? ruleSet.groups : undefined,
  usage: ruleSet.usage,
  originalModes,
});

export const ManagedRuleSetProvider = () =>
  Provider.succeed(ManagedRuleSet, {
    stables: ["ruleSetName", "projectId", "region", "type"],
    // Nuke ordering: `Stackit.WAF.Configuration` declares a dependency on this type.

    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const scope = { projectId: env.projectId, region: env.region };
      const ruleSets = yield* listAllManagedRuleSets(scope);
      // No labels to prove ownership: only generated names are cleared.
      return ruleSets
        .filter((ruleSet) => isGeneratedPhysicalName(ruleSet.name, NAME_MAX_LENGTH))
        .map((ruleSet) => toAttrs(scope, ruleSet, {}));
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      // An explicit name could resolve to the one the old rule set holds: delete
      // it first. A generated name carries the generation.
      if (
        hasUnresolvedTrigger<ManagedRuleSetProps>(news, ["name", "projectId", "region", "type"])
      ) {
        return {
          action: "replace",
          deleteFirst: rawProp<ManagedRuleSetProps>(news, "name") !== undefined,
        } as const;
      }
      const resolved = triggerProps<ManagedRuleSetProps>(news);
      const scopeChanged = yield* projectScopeChanged(resolved, output);
      const nameChanged =
        resolved.name !== undefined
          ? resolved.name !== output.ruleSetName
          : olds?.name !== undefined;
      if (scopeChanged || nameChanged || (resolved.type ?? DEFAULT_TYPE) !== output.type) {
        // A new name or scope can't collide with the old one; the same explicit
        // name with a new type must be freed first.
        return {
          action: "replace",
          deleteFirst: resolved.name !== undefined && !scopeChanged && !nameChanged,
        } as const;
      }
      // Everything else updates in place (engine default: props changed).
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output, previous }) {
      const scope = yield* resolveProjectScope(olds, output);
      const explicit = output?.ruleSetName ?? olds?.name;
      const name = explicit ?? (yield* physicalName(id));
      const observed = yield* getManagedRuleSetOrUndefined(scope, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(scope, observed, output?.originalModes ?? {});
      // No labels: a rule set is ours when it is in state, carries this generation's
      // generated name, or is the generation being replaced, at that one's own scope.
      const owned =
        output !== undefined ||
        explicit === undefined ||
        (previous?.ruleSetName === name &&
          previous.projectId === scope.projectId &&
          previous.region === scope.region);
      return owned ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const name = news.name ?? output?.ruleSetName ?? (yield* physicalName(id));

      yield* ensureServiceEnabled({ ...scope, serviceId: LOAD_BALANCER_SERVICE_ID });

      // 1. Observe. The name is the API's key.
      const observed = yield* getManagedRuleSetOrUndefined(scope, name);

      // 2. Ensure.
      const current =
        observed ??
        (yield* waf.createManagedRuleSet({
          ...scope,
          name,
          type: news.type ?? DEFAULT_TYPE,
        }));

      // 3. Sync, against the observed mode of each rule. A rule's original mode is
      // recorded the first time the props name it, so removing it can restore that.
      const modeOf = (groupId: string, ruleId: string) =>
        current.groups?.[groupId]?.rules?.[ruleId]?.mode;
      const originalModes: Record<string, Record<string, waf.Mode>> = Object.fromEntries(
        Object.entries(output?.originalModes ?? {}).map(([groupId, rules]) => [
          groupId,
          { ...rules },
        ]),
      );
      const patch: Record<string, waf.PatchMRSRuleGroup> = {};
      const setMode = (groupId: string, ruleId: string, mode: waf.Mode) => {
        patch[groupId] = { rules: { ...patch[groupId]?.rules, [ruleId]: { mode } } };
      };

      for (const [groupId, group] of Object.entries(news.groups ?? {})) {
        for (const [ruleId, { mode }] of Object.entries(group.rules)) {
          const live = modeOf(groupId, ruleId);
          if (live !== undefined && originalModes[groupId]?.[ruleId] === undefined) {
            originalModes[groupId] = { ...originalModes[groupId], [ruleId]: live };
          }
          if (live !== mode) setMode(groupId, ruleId, mode);
        }
      }
      for (const [groupId, rules] of Object.entries(originalModes)) {
        for (const [ruleId, mode] of Object.entries(rules)) {
          if (news.groups?.[groupId]?.rules[ruleId] !== undefined) continue;
          if (modeOf(groupId, ruleId) !== mode) setMode(groupId, ruleId, mode);
          delete rules[ruleId];
        }
      }

      if (Object.keys(patch).length === 0) return toAttrs(scope, current, originalModes);
      const patched = yield* waf.patchManagedRuleSet({ ...scope, name, groups: patch });

      // 4. Return
      return toAttrs(scope, patched, originalModes);
    }),

    delete: Effect.fn(function* ({ output }) {
      const scope = { projectId: output.projectId, region: output.region };
      const name = output.ruleSetName;
      // The spec types no 404 on this delete, so read first: gone is done.
      const current = yield* getManagedRuleSetOrUndefined(scope, name);
      if (current === undefined) return;
      yield* retryWhileInUse(waf.deleteManagedRuleSet({ ...scope, name }));
    }),
  });
