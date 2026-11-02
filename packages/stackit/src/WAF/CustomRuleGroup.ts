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
import { getCustomRuleGroupOrUndefined, listAllCustomRuleGroups } from "./internal.ts";

/** What a rule does when its conditions match. */
export interface CustomRuleBehavior {
  /** `ACTION_DENY` answers with a 403. */
  action: waf.Action;
  /** Log a hit in the security ledger. */
  log?: boolean;
  /** Message logged with a hit. */
  logMsg?: string;
}

/** One check of a rule. */
export interface CustomRuleCondition {
  /** The part of the request or response to inspect. */
  variable: {
    /** Which variable. */
    type: waf.Variable;
    /** Key for a map variable, e.g. the header name `Host`. */
    value?: string;
  };
  /** How to evaluate the variable. */
  operator: {
    /** Which operator. */
    type: waf.Operator;
    /** Text or pattern the operator evaluates against. */
    value?: string;
  };
  /** Adjustments applied to the input before matching, in order. */
  transformations?: waf.Transformation[];
}

/** One rule of a custom rule group. */
export interface CustomRule {
  /** What the rule does on a match. */
  behavior: CustomRuleBehavior;
  /** The rule's conditions, in order. Order is significant. */
  conditions: CustomRuleCondition[];
  /** Why the rule exists. */
  description?: string;
}

export interface CustomRuleGroupProps extends ProjectScopedProps {
  /**
   * Name of the rule group, the API's key for it: 1-63 characters of `[0-9a-z-]`.
   * Changing it replaces the rule group.
   * @default a physical name generated from the app, stage and logical id
   */
  name?: string;
  /** The rules, as the group's complete content. An update replaces them all. */
  rules: CustomRule[];
}

export interface CustomRuleGroupAttributes {
  /** Name of the rule group, which a `Configuration` takes as `customRuleGroupName`. */
  ruleGroupName: string;
  /** Project of the rule group. */
  projectId: string;
  /** Region of the rule group. */
  region: string;
  /** The rules as STACKIT reports them, with allocated ids and computed severities. */
  rules: waf.GetCustomRule[];
  /** The WAF configurations using it when last read. */
  usage: waf.CRGUsage | undefined;
}

export type CustomRuleGroup = Resource<
  "Stackit.WAF.CustomRuleGroup",
  CustomRuleGroupProps,
  CustomRuleGroupAttributes,
  never,
  Providers
>;

/**
 * A STACKIT web application firewall custom rule group: your own rules, which a
 * `Stackit.WAF.Configuration` applies through `customRuleGroupName`.
 *
 * Rules update in place, replacing the group's content as a whole. A new name or
 * scope replaces the group. The first deploy also enables the service
 * (`cloud.stackit.loadbalancer`) for the project. STACKIT refuses to delete a
 * group a configuration still uses; a delete retries for about a minute, then
 * fails with the API's `BadRequest`.
 *
 * Ownership: rule groups have no labels, so the name in Alchemy's state is the
 * identity. A group of an explicit name that Alchemy didn't record is reported
 * as unowned and only taken over with `--adopt`. `alchemy unsafe nuke` only
 * clears groups with the shape of a generated physical name, so choose a name
 * outside that shape for a group that must survive a nuke.
 *
 * See [STACKIT's ALB WAF docs](https://docs.stackit.cloud/products/network/load-balancing-and-content-delivery/application-load-balancer/basics/basic-concepts-alb-waf/).
 *
 * :::caution[Changing `name`, `projectId` or `region` replaces the Rule Group]
 * STACKIT refuses to delete a group a configuration still uses: a delete retries for
 * about a minute, then fails with the API's `BadRequest`. `rules` update in place.
 * :::
 *
 * ### Creating a Rule Group
 * **Example:** Deny a request by a header
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const group = yield* Stackit.WAF.CustomRuleGroup("Bots", {
 *   rules: [
 *     {
 *       description: "Known scraper",
 *       behavior: { action: "ACTION_DENY", log: true, logMsg: "scraper" },
 *       conditions: [
 *         {
 *           variable: { type: "VARIABLE_REQUEST_HEADERS", value: "User-Agent" },
 *           operator: { type: "OPERATOR_CONTAINS", value: "badbot" },
 *           transformations: ["TRANSFORMATION_LOWERCASE"],
 *         },
 *       ],
 *     },
 *   ],
 * });
 * ```
 *
 * **Example:** Let an office range through
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const group = yield* Stackit.WAF.CustomRuleGroup("Office", {
 *   name: "office-allow",
 *   rules: [
 *     {
 *       behavior: { action: "ACTION_ALLOW" },
 *       conditions: [
 *         {
 *           variable: { type: "VARIABLE_REMOTE_ADDR" },
 *           operator: { type: "OPERATOR_IP_MATCH", value: "203.0.113.0/24" },
 *         },
 *       ],
 *     },
 *   ],
 * });
 * ```
 *
 * ### Using it in a Firewall
 * **Example:** Apply the group through a configuration
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const group = yield* Stackit.WAF.CustomRuleGroup("Bots", {
 *   rules: [
 *     {
 *       behavior: { action: "ACTION_DENY" },
 *       conditions: [
 *         {
 *           variable: { type: "VARIABLE_REQUEST_URI_RAW" },
 *           operator: { type: "OPERATOR_BEGINS_WITH", value: "/admin" },
 *         },
 *       ],
 *     },
 *   ],
 * });
 * const firewall = yield* Stackit.WAF.Configuration("Firewall", {
 *   customRuleGroupName: group.ruleGroupName,
 * });
 * ```
 *
 * ### Runtime Operations
 * **Example:** Replace the rules from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * const denyPath = (path: string) => ({
 *   behavior: { action: "ACTION_DENY" as const },
 *   conditions: [
 *     {
 *       variable: { type: "VARIABLE_REQUEST_URI_RAW" as const },
 *       operator: { type: "OPERATOR_BEGINS_WITH" as const, value: path },
 *     },
 *   ],
 * });
 *
 * export const Blocks = Stackit.WAF.CustomRuleGroup("Blocks", {
 *   rules: [denyPath("/admin")],
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const updateGroup = yield* Stackit.WAF.UpdateCustomRuleGroup(yield* Blocks);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* updateGroup({ rules: [denyPath("/admin"), denyPath("/debug")] });
 *         return HttpServerResponse.text("updated");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.WAF.UpdateCustomRuleGroupHttp)),
 * ) {}
 * ```
 *
 * ### Replacement Cautions
 * **Example:** Renaming a rule group a configuration uses
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * // A new name creates the new group first, the configuration moves to it, and
 * // the old group is deleted.
 * const group = yield* Stackit.WAF.CustomRuleGroup("Bots", {
 *   name: "bots-v2",
 *   rules: [
 *     {
 *       behavior: { action: "ACTION_DENY" },
 *       conditions: [
 *         {
 *           variable: { type: "VARIABLE_REQUEST_METHOD" },
 *           operator: { type: "OPERATOR_STREQ", value: "TRACE" },
 *         },
 *       ],
 *     },
 *   ],
 * });
 * const firewall = yield* Stackit.WAF.Configuration("Firewall", {
 *   customRuleGroupName: group.ruleGroupName,
 * });
 * ```
 *
 * @resource
 * @product STACKIT ALB Web Application Firewall
 * @category WAF
 */
export const CustomRuleGroup = Resource<CustomRuleGroup>("Stackit.WAF.CustomRuleGroup");

const toAttrs = (
  scope: ProjectScope,
  group: waf.GetCustomRuleGroupResponse,
): CustomRuleGroupAttributes => ({
  ruleGroupName: group.name,
  ...scope,
  rules: [...group.rules],
  usage: group.usage,
});

const sameTransformations = (
  desired: ReadonlyArray<string> | undefined,
  observed: ReadonlyArray<string> | undefined,
) =>
  desired === undefined ||
  (desired.length === (observed?.length ?? 0) && desired.every((t, i) => t === observed?.[i]));

const sameCondition = (desired: CustomRuleCondition, observed: waf.Condition) =>
  desired.variable.type === observed.variable.type &&
  (desired.variable.value ?? "") === (observed.variable.value ?? "") &&
  desired.operator.type === observed.operator.type &&
  (desired.operator.value ?? "") === (observed.operator.value ?? "") &&
  sameTransformations(desired.transformations, observed.transformations);

/**
 * Whether an observed rule holds what a desired rule sets. Order is significant
 * in both lists. A field the props leave out is ignored, so the allocated `id`,
 * the computed `severity` and the `log` default never count as drift.
 */
const sameRule = (desired: CustomRule, observed: waf.GetCustomRule) =>
  desired.behavior.action === observed.behavior.action &&
  (desired.behavior.log === undefined || desired.behavior.log === observed.behavior.log) &&
  (desired.behavior.logMsg === undefined || desired.behavior.logMsg === observed.behavior.logMsg) &&
  (desired.description === undefined || desired.description === observed.description) &&
  desired.conditions.length === observed.conditions.length &&
  desired.conditions.every((condition, index) =>
    sameCondition(condition, observed.conditions[index]!),
  );

const sameRules = (
  desired: ReadonlyArray<CustomRule>,
  observed: ReadonlyArray<waf.GetCustomRule>,
) =>
  desired.length === observed.length &&
  desired.every((rule, index) => sameRule(rule, observed[index]!));

export const CustomRuleGroupProvider = () =>
  Provider.succeed(CustomRuleGroup, {
    stables: ["ruleGroupName", "projectId", "region"],
    // Nuke ordering: `Stackit.WAF.Configuration` declares a dependency on this type.

    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const scope = { projectId: env.projectId, region: env.region };
      const groups = yield* listAllCustomRuleGroups(scope);
      // No labels to prove ownership: only generated names are cleared.
      return groups
        .filter((group) => isGeneratedPhysicalName(group.name, NAME_MAX_LENGTH))
        .map((group) => toAttrs(scope, group));
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      // An explicit name could resolve to the one the old group holds: delete it
      // first. A generated name carries the generation.
      if (hasUnresolvedTrigger<CustomRuleGroupProps>(news, ["name", "projectId", "region"])) {
        return {
          action: "replace",
          deleteFirst: rawProp<CustomRuleGroupProps>(news, "name") !== undefined,
        } as const;
      }
      const resolved = triggerProps<CustomRuleGroupProps>(news);
      const scopeChanged = yield* projectScopeChanged(resolved, output);
      const nameChanged =
        resolved.name !== undefined
          ? resolved.name !== output.ruleGroupName
          : olds?.name !== undefined;
      // A new name or scope can't collide with the old one, so it comes up first.
      if (scopeChanged || nameChanged) return { action: "replace" } as const;
      // Everything else updates in place (engine default: props changed).
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output, previous }) {
      const scope = yield* resolveProjectScope(olds, output);
      const explicit = output?.ruleGroupName ?? olds?.name;
      const name = explicit ?? (yield* physicalName(id));
      const observed = yield* getCustomRuleGroupOrUndefined(scope, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(scope, observed);
      // No labels: a group is ours when it is in state, carries this generation's
      // generated name, or is the generation being replaced, at that one's own scope.
      const owned =
        output !== undefined ||
        explicit === undefined ||
        (previous?.ruleGroupName === name &&
          previous.projectId === scope.projectId &&
          previous.region === scope.region);
      return owned ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const name = news.name ?? output?.ruleGroupName ?? (yield* physicalName(id));

      yield* ensureServiceEnabled({ ...scope, serviceId: LOAD_BALANCER_SERVICE_ID });

      // 1. Observe. The name is the API's key.
      const observed = yield* getCustomRuleGroupOrUndefined(scope, name);

      // 2. Ensure.
      if (observed === undefined) {
        const created = yield* waf.createCustomRuleGroup({ ...scope, name, rules: news.rules });
        return toAttrs(scope, created);
      }

      // 3. Sync. Observed rules can't show a field the user removed, since the
      // comparison ignores what `news` leaves out: the previous props flag it.
      const declarationChanged =
        olds !== undefined && JSON.stringify(olds.rules) !== JSON.stringify(news.rules);
      if (!declarationChanged && sameRules(news.rules, observed.rules)) {
        return toAttrs(scope, observed);
      }
      const updated = yield* waf.updateCustomRuleGroup({ ...scope, name, rules: news.rules });

      // 4. Return
      return toAttrs(scope, updated);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* retryWhileInUse(
        waf.deleteCustomRuleGroup({
          projectId: output.projectId,
          region: output.region,
          name: output.ruleGroupName,
        }),
      ).pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
