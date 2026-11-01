import * as ufw from "@distilled.cloud/stackit/ufw";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { projectScopeChanged, resolveProjectScope } from "../IaaS/internal.ts";
import { hasUnresolvedTrigger, triggerProps } from "../internal/diff.ts";
import { makeKeyedLock } from "../internal/lock.ts";
import { waitFor, waitUntilGone } from "../internal/wait.ts";
import type { Providers } from "../Providers.ts";
import { getRuleOrUndefined, RULE_TIMEOUT, type RuleScope, ruleTarget } from "./internal.ts";

/** A create response of a rule carried no id, so there is nothing to wait on or to record. */
export class RuleIdMissing extends Data.TaggedError("Stackit.UnifiedFirewall.RuleIdMissing")<{
  readonly product: string;
  readonly instanceId: string;
  readonly message: string;
}> {}

/** What a rule writes to on its target. */
export type RuleType = ufw.RuleResponseType;

export interface RuleProps {
  /**
   * Product the rule applies to, e.g. `edge-cloud`. `Stackit.UnifiedFirewall.ListProviderOptions`
   * lists the products of a region, and the rule types each one takes. Changing it replaces the
   * rule.
   */
  product: string;
  /** Id of the product's instance the rule applies to. Changing it replaces the rule. */
  instanceId: string;
  /** Kind of rule. Changing it replaces the rule. */
  type: RuleType;
  /** The IP range (CIDR) the rule applies to, e.g. `192.0.2.0/24`. Updates in place. */
  sourceIP: string;
  /**
   * The port range the rule applies to, e.g. `8080-8090`. Updates in place; omit to leave the
   * live value alone.
   */
  portRange?: string;
  /**
   * The network protocol, e.g. `TCP`, `UDP` or `ICMP`. Updates in place; omit to leave the live
   * value alone.
   */
  protocol?: string;
  /**
   * The direction of the traffic, typically `ingress` or `egress`. Updates in place; omit to
   * leave the live value alone.
   */
  direction?: string;
  /** The ether type, e.g. `IPv4`. Updates in place; omit to leave the live value alone. */
  etherType?: string;
  /** Id of the security group. Updates in place; omit to leave the live value alone. */
  securityGroupId?: string;
  /**
   * Id of the remote security group. The API can't change it, so changing it replaces the rule.
   */
  remoteSecurityGroupId?: string;
  /**
   * Description of the rule. The API can't change it, so changing it replaces the rule.
   */
  description?: string;
  /**
   * Whether a security group rule is stateful. Only used for security groups. The API can't
   * change it, so changing it replaces the rule.
   */
  stateful?: boolean;
  /**
   * Position of the rule in the list. The API can't change it, so changing it replaces the rule.
   */
  offset?: number;
  /** Project of the rule. Defaults to the profile's project. Changing it replaces the rule. */
  projectId?: string;
  /** Region of the rule. Defaults to the profile's region. Changing it replaces the rule. */
  region?: string;
}

export interface RuleAttributes {
  /** STACKIT rule id (`refId`, a UUID). */
  ruleId: string;
  /** Project of the rule. */
  projectId: string;
  /** Region of the rule. */
  region: string;
  /** Product the rule applies to. */
  product: string;
  /** Instance the rule applies to. */
  instanceId: string;
  /** Name of the instance, as STACKIT reports it. */
  instanceName: string | undefined;
  /** Kind of rule. */
  type: RuleType;
  /** The IP range the rule applies to. */
  sourceIP: string;
  /** The destination, as STACKIT reports it. */
  destination: string;
  /** The IP range, as STACKIT reports it. */
  ipRange: string | undefined;
  /** The port range, if any. */
  portRange: string | undefined;
  /** The network protocol, if any. */
  protocol: string | undefined;
  /** The direction of the traffic, if any. */
  direction: string | undefined;
  /** The ether type, if any. */
  etherType: string | undefined;
  /** Id of the security group, if any. */
  securityGroupId: string | undefined;
  /** Id of the remote security group, if any. */
  remoteSecurityGroupId: string | undefined;
  /** Description of the rule, if any. */
  description: string | undefined;
  /** Whether a security group rule is stateful, if STACKIT reports it. */
  stateful: boolean | undefined;
  /** Position of the rule in the list, if STACKIT reports it. */
  offset: number | undefined;
  /** State of the rule: `Active` after a deploy. */
  status: ufw.RuleResponseStatus;
  /** What went wrong, when the rule is in `Error`. */
  errorMessage: string | undefined;
}

export type Rule = Resource<
  "Stackit.UnifiedFirewall.Rule",
  RuleProps,
  RuleAttributes,
  never,
  Providers
>;

/**
 * One access rule written through STACKIT's Unified Firewall, the API that covers the access
 * rules of other products: ACLs on managed services, public IPs, and security group rules.
 * Deploys wait until the rule is `Active`, and destroys wait until it is gone.
 *
 * A rule is one object, created, changed and deleted by its own id, so a deploy never writes
 * the rest of the instance's rules, and rules someone else added stay where they are.
 *
 * **Don't manage the same access twice.** A rule on a product that also declares its own access
 * list (`allowedSourceRanges`, `acl`, a `Stackit.IaaS.SecurityGroupRule`) is managed by two
 * resources, and the other resource's next reconcile may revert it. Use the product's own prop
 * when the instance is in your stack, and a `Rule` when it isn't, or when the same call has to
 * cover several products.
 *
 * Rules have no labels, no name and no field that could hold an ownership marker. Alchemy knows
 * its own by the id in state. A deploy with no state that finds exactly one rule with the same
 * target and traffic reports it as unowned, and only takes it over with `--adopt`. That includes
 * a rule this stack created in a deploy that crashed before writing state, because nothing tells
 * the two apart. For the same reason `alchemy unsafe nuke` can't find rules: they go with their
 * stack's `destroy`.
 *
 * Writes on one instance run one at a time within a deploy.
 *
 * ### Creating a Rule
 * **Example:** Allow one range on an instance
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const office = yield* Stackit.UnifiedFirewall.Rule("Office", {
 *   product: "edge-cloud",
 *   instanceId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
 *   type: "ACL",
 *   sourceIP: "192.0.2.0/24",
 *   description: "Office network",
 * });
 * ```
 *
 * **Example:** A security group rule
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const group = yield* Stackit.IaaS.SecurityGroup("Web", {});
 * const https = yield* Stackit.UnifiedFirewall.Rule("Https", {
 *   // A product whose `types` in `ListProviderOptions` include `SecurityRule`.
 *   product: "<product>",
 *   instanceId: "<instance id>",
 *   securityGroupId: group.securityGroupId,
 *   type: "SecurityRule",
 *   sourceIP: "0.0.0.0/0",
 *   direction: "ingress",
 *   etherType: "IPv4",
 *   protocol: "TCP",
 *   portRange: "443-443",
 * });
 * ```
 *
 * ### Blocking at Runtime
 * **Example:** Add a rule from a Cloudflare Worker during an incident
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Web = Stackit.IaaS.SecurityGroup("Web", {});
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const createRule = yield* Stackit.UnifiedFirewall.CreateRule(yield* Web);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { refId } = yield* createRule({
 *           product: "edge-cloud",
 *           instanceId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
 *           type: "ACL",
 *           sourceIP: "192.0.2.0/24",
 *         });
 *         return yield* HttpServerResponse.json({ refId });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.UnifiedFirewall.CreateRuleHttp)),
 * ) {}
 * ```
 *
 * ### What Deleting Does <!-- api-prose -->
 * A delete acts on this one rule by its id, and waits until it is gone. A rule that's already
 * gone counts as deleted.
 *
 * ### Replacement Cautions <!-- api-prose -->
 * Changing `product`, `instanceId`, `type`, `projectId` or `region` creates the new rule first,
 * then deletes the old one. Changing `remoteSecurityGroupId`, `description`, `stateful` or
 * `offset`, which the API can't update, or a target that isn't known at plan, deletes the old
 * rule first, because the new one would match the same traffic. Until the new rule is `Active`,
 * the access that rule described is not in place.
 *
 * @resource
 * @product STACKIT Unified Firewall
 * @category UnifiedFirewall
 */
export const Rule = Resource<Rule>("Stackit.UnifiedFirewall.Rule");

/**
 * The API takes one rule at a time, but a rule of type `ACL` lands on one instance's access
 * list. STACKIT doesn't document whether concurrent writes to one instance are safe, so within
 * a deploy they go one at a time, each until the rule settles.
 */
const withInstanceLock = /*@__PURE__*/ makeKeyedLock();

const instanceLock = (
  scope: RuleScope,
  target: { readonly product: string; readonly instanceId: string },
) => withInstanceLock(`${scope.projectId}/${scope.region}/${target.product}/${target.instanceId}`);

const toAttrs = (scope: RuleScope, ruleId: string, rule: ufw.RuleResponse): RuleAttributes => ({
  ruleId,
  projectId: scope.projectId,
  region: scope.region,
  product: rule.product,
  instanceId: rule.instanceId,
  instanceName: rule.instanceName,
  type: rule.type,
  sourceIP: rule.sourceIP,
  destination: rule.destination,
  ipRange: rule.ipRange,
  portRange: rule.portRange,
  protocol: rule.protocol,
  direction: rule.direction,
  etherType: rule.etherType,
  securityGroupId: rule.securityGroupId,
  remoteSecurityGroupId: rule.remoteSecurityGroupId,
  description: rule.description === "" ? undefined : rule.description,
  stateful: rule.stateful,
  offset: rule.offset,
  status: rule.status,
  errorMessage: rule.errorMessage === "" ? undefined : rule.errorMessage,
});

/** The spec's own examples spell these in both cases (`TCP`, `tcp`). */
const sameText = (a: string | undefined, b: string | undefined) =>
  (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

/** `443` and `443-443` are one port. */
const samePortRange = (a: string | undefined, b: string | undefined) => {
  const expand = (range: string | undefined) =>
    range !== undefined && !range.includes("-") ? `${range}-${range}` : (range ?? "");
  return expand(a) === expand(b);
};

/** The traffic a PUT can change: whether the rule differs from the props that are set. */
const trafficDrifted = (rule: ufw.RuleResponse, news: RuleProps): boolean =>
  rule.sourceIP !== news.sourceIP ||
  (news.portRange !== undefined && !samePortRange(rule.portRange, news.portRange)) ||
  (news.protocol !== undefined && !sameText(rule.protocol, news.protocol)) ||
  (news.direction !== undefined && !sameText(rule.direction, news.direction)) ||
  (news.etherType !== undefined && !sameText(rule.etherType, news.etherType)) ||
  (news.securityGroupId !== undefined && rule.securityGroupId !== news.securityGroupId);

/** Whether a rule found without state is the one these props describe. */
const describesSameRule = (rule: ufw.RuleResponse, news: RuleProps): boolean =>
  rule.product === news.product &&
  rule.instanceId === news.instanceId &&
  rule.type === news.type &&
  !trafficDrifted(rule, news);

/**
 * The PUT's body. The spec doesn't say whether a field left out is kept or cleared, so one the
 * props leave alone is sent back as observed.
 */
const updateBodyOf = (rule: ufw.RuleResponse, news: RuleProps) => {
  const portRange = news.portRange ?? rule.portRange;
  const protocol = news.protocol ?? rule.protocol;
  const direction = news.direction ?? rule.direction;
  const etherType = news.etherType ?? rule.etherType;
  const securityGroupId = news.securityGroupId ?? rule.securityGroupId;
  return {
    sourceIP: news.sourceIP,
    ...(portRange !== undefined ? { portRange } : {}),
    ...(protocol !== undefined ? { protocol } : {}),
    ...(direction !== undefined ? { direction } : {}),
    ...(etherType !== undefined ? { etherType } : {}),
    ...(securityGroupId !== undefined ? { securityGroupId } : {}),
  };
};

/** A write that hasn't settled yet: wait for `Active`, failing on `Error`. */
const waitForActive = (
  scope: RuleScope,
  ruleId: string,
  read: Effect.Effect<ufw.RuleResponse, ufw.GetRuleError, ufw.StackitOpContext>,
  settled: (rule: ufw.RuleResponse) => boolean = () => true,
) =>
  waitFor({
    resource: `STACKIT firewall rule ${ruleId} in ${scope.projectId}/${scope.region}`,
    read,
    ready: (rule) => rule.status === "Active" && settled(rule),
    failed: (rule) =>
      rule.status === "Error" || rule.status === "Deleting"
        ? (rule.errorMessage ?? rule.status)
        : undefined,
    state: (rule) => rule.status,
    timeout: RULE_TIMEOUT,
  });

const readRule = (scope: RuleScope, ruleId: string) =>
  ufw.getRule({ ...ruleTarget(scope), ruleId });

/**
 * Delete one rule by its id and wait until it is gone. `deleteRule` documents its 404 as a
 * missing project, which holds no rule either. `Error` only fails a rule that wasn't in it
 * already, so a stale failure can't fail the delete that clears it.
 */
const deleteRuleAndWait = (scope: RuleScope, ruleId: string) =>
  Effect.gen(function* () {
    const current = yield* getRuleOrUndefined(scope, ruleId);
    if (current === undefined) return;
    if (current.status !== "Deleting") {
      yield* ufw
        .deleteRule({ ...ruleTarget(scope), ruleId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }
    const startedInError = current.status === "Error";
    yield* waitUntilGone({
      resource: `STACKIT firewall rule ${ruleId} in ${scope.projectId}/${scope.region}`,
      read: getRuleOrUndefined(scope, ruleId),
      failed: (rule) =>
        rule.status === "Error" && !startedInError ? (rule.errorMessage ?? rule.status) : undefined,
      state: (rule) => rule.status,
      timeout: RULE_TIMEOUT,
    });
  });

/** A prop the API can't update changed. Removing it asks for nothing, so it replaces nothing. */
const changedFrom = <T>(desired: T | undefined, recorded: T | undefined): boolean =>
  desired !== undefined && desired !== recorded;

export const RuleProvider = () =>
  Provider.succeed(Rule, {
    stables: ["ruleId", "projectId", "region", "product", "instanceId", "type"],
    // No `list`: `listRules` returns every rule, including those other products wrote, and
    // nothing on a rule says who wrote it. `alchemy unsafe nuke` must not sweep them.

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      // A rule's identity holds no generation, and an unresolved target can resolve to the one
      // it already has: the old rule goes first.
      if (
        hasUnresolvedTrigger<RuleProps>(news, [
          "product",
          "instanceId",
          "type",
          "remoteSecurityGroupId",
          "description",
          "stateful",
          "offset",
          "projectId",
          "region",
        ])
      ) {
        return { action: "replace", deleteFirst: true } as const;
      }
      const resolved = triggerProps<RuleProps>(news);
      const scopeChanged = yield* projectScopeChanged(resolved, output);
      if (
        scopeChanged ||
        resolved.product !== (olds?.product ?? output.product) ||
        resolved.instanceId !== (olds?.instanceId ?? output.instanceId) ||
        resolved.type !== (olds?.type ?? output.type)
      ) {
        // A different target: the two rules can't collide, and the new one is in place first.
        return { action: "replace", deleteFirst: false } as const;
      }
      if (
        changedFrom(
          resolved.remoteSecurityGroupId,
          olds?.remoteSecurityGroupId ?? output.remoteSecurityGroupId,
        ) ||
        changedFrom(resolved.description || undefined, olds?.description ?? output.description) ||
        changedFrom(resolved.stateful, olds?.stateful ?? output.stateful) ||
        changedFrom(resolved.offset, olds?.offset ?? output.offset)
      ) {
        // Not in the PUT's body. The new rule would match the same traffic as the old one.
        return { action: "replace", deleteFirst: true } as const;
      }
      // Everything else updates in place (engine default: props changed).
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output, previous }) {
      const scope = yield* resolveProjectScope(olds, output);
      if (output !== undefined) {
        const rule = yield* getRuleOrUndefined(scope, output.ruleId);
        return rule === undefined ? undefined : toAttrs(scope, output.ruleId, rule);
      }
      if (olds?.product === undefined) return undefined;
      // Nothing recorded. Nothing on a rule says whose it is, so a match is only ever reported
      // as unowned. The listing answers no cursor to page with, so it asks for as much of the
      // rule as the props state: a match has to be on the one page there is. Its `errors` can
      // only hide a match, and creating is what happens without one anyway.
      const { rules } = yield* ufw
        .listRules({
          ...ruleTarget(scope),
          product: olds.product,
          instanceId: olds.instanceId,
          type: olds.type,
          sourceIP: olds.sourceIP,
          ...(olds.portRange !== undefined ? { portRange: olds.portRange } : {}),
          ...(olds.protocol !== undefined ? { protocol: olds.protocol } : {}),
          ...(olds.direction !== undefined ? { direction: olds.direction } : {}),
          ...(olds.etherType !== undefined ? { etherType: olds.etherType } : {}),
        })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.succeed<ufw.ListRulesResponse>({ rules: [] })),
        );
      // Rules matching twice are evidently no identity, so they claim nothing.
      const same = rules.filter((rule) => describesSameRule(rule, olds));
      if (same.length !== 1 || same[0]!.refId === undefined) return undefined;
      const attrs = toAttrs(scope, same[0]!.refId, same[0]!);
      const isPrevious =
        previous?.ruleId === attrs.ruleId &&
        previous.projectId === scope.projectId &&
        previous.region === scope.region;
      return isPrevious ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const target = ruleTarget(scope);
      return yield* Effect.gen(function* () {
        // 1. Observe — `output` is a cache for the id, and only names the desired rule at the
        // same scope.
        let ruleId = output?.ruleId;
        let current =
          ruleId !== undefined &&
          output?.projectId === scope.projectId &&
          output.region === scope.region
            ? yield* getRuleOrUndefined(scope, ruleId)
            : undefined;

        // A rule on its way out, or one that failed, can't be repaired: finish it and recreate.
        if (current?.status === "Deleting" || current?.status === "Error") {
          yield* deleteRuleAndWait(scope, ruleId!);
          current = undefined;
        }

        // 2. Ensure
        if (current === undefined) {
          const { refId } = yield* ufw.createRule({
            ...target,
            product: news.product,
            instanceId: news.instanceId,
            type: news.type,
            sourceIP: news.sourceIP,
            ...(news.portRange !== undefined ? { portRange: news.portRange } : {}),
            ...(news.protocol !== undefined ? { protocol: news.protocol } : {}),
            ...(news.direction !== undefined ? { direction: news.direction } : {}),
            ...(news.etherType !== undefined ? { etherType: news.etherType } : {}),
            ...(news.securityGroupId !== undefined
              ? { securityGroupId: news.securityGroupId }
              : {}),
            ...(news.remoteSecurityGroupId !== undefined
              ? { remoteSecurityGroupId: news.remoteSecurityGroupId }
              : {}),
            ...(news.description !== undefined ? { description: news.description } : {}),
            ...(news.stateful !== undefined ? { stateful: news.stateful } : {}),
            ...(news.offset !== undefined ? { offset: news.offset } : {}),
          });
          if (refId === undefined) {
            return yield* new RuleIdMissing({
              product: news.product,
              instanceId: news.instanceId,
              message: `STACKIT returned no id for a new ${news.type} rule on ${news.product} ${news.instanceId}`,
            });
          }
          ruleId = refId;
          // Not in state until this returns: a rule that never settles is removed here, or the
          // next deploy has no id to find it by. A rule may not be readable at once.
          current = yield* waitForActive(
            scope,
            refId,
            readRule(scope, refId).pipe(
              Effect.retry({
                while: (error) => error._tag === "NotFound",
                schedule: Schedule.spaced("2 seconds"),
                times: 5,
              }),
            ),
          ).pipe(
            Effect.onError(() => ufw.deleteRule({ ...target, ruleId: refId }).pipe(Effect.ignore)),
          );
        }

        const liveId = ruleId!;
        if (current.status !== "Active") {
          current = yield* waitForActive(scope, liveId, readRule(scope, liveId));
        }

        // 3. Sync — diffed against the observed rule. A PUT is answered with 202: wait for the
        // desired values too, so a read from before it can't pass.
        if (trafficDrifted(current, news)) {
          const { refId } = yield* ufw.updateRule({
            ...target,
            ruleId: liveId,
            ...updateBodyOf(current, news),
          });
          ruleId = refId ?? liveId;
          current = yield* waitForActive(
            scope,
            ruleId,
            readRule(scope, ruleId),
            (rule) => !trafficDrifted(rule, news),
          );
        }

        // 4. Return
        return toAttrs(scope, ruleId!, current);
      }).pipe(instanceLock(scope, news));
    }),

    delete: Effect.fn(function* ({ output }) {
      const scope = { projectId: output.projectId, region: output.region };
      yield* deleteRuleAndWait(scope, output.ruleId).pipe(instanceLock(scope, output));
    }),
  });
