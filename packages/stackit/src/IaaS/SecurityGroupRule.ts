import * as iaas from "@distilled.cloud/stackit/iaas";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { waitUntilGone } from "../internal/wait.ts";
import type { Providers } from "../Providers.ts";
import { projectScopeChanged, resolveProjectScope, type ProjectScope } from "./internal.ts";

/** The create response of a security group rule carried no id. */
export class SecurityGroupRuleIdMissing extends Data.TaggedError(
  "Stackit.IaaS.SecurityGroupRuleIdMissing",
)<{
  readonly securityGroupId: string;
  readonly message: string;
}> {}

/** A port range of a {@link SecurityGroupRule}. */
export interface SecurityGroupRulePortRange {
  /** Lowest port, 1-65535. */
  min: number;
  /** Highest port, at least `min`. */
  max: number;
}

/** ICMP type and code of a {@link SecurityGroupRule}. */
export interface SecurityGroupRuleIcmp {
  /** ICMP type, e.g. `8` (echo request). */
  type: number;
  /** ICMP code, e.g. `0`. */
  code: number;
}

export interface SecurityGroupRuleProps {
  /** Security group the rule belongs to. Changing it replaces the rule. */
  securityGroupId: string;
  /**
   * Project of the security group. Defaults to the profile's project.
   * Changing it replaces the rule.
   */
  projectId?: string;
  /**
   * Region of the security group. Defaults to the profile's region.
   * Changing it replaces the rule.
   */
  region?: string;
  /** Direction of the traffic the rule matches. Changing it replaces the rule. */
  direction: "ingress" | "egress";
  /**
   * Address family the rule matches. Changing it replaces the rule.
   * @default "IPv4"
   */
  ethertype?: "IPv4" | "IPv6";
  /**
   * Protocol the rule matches: a name (`tcp`, `udp`, `icmp`, `icmpv6`,
   * `any`, ...) or an IANA protocol number. When omitted, every protocol
   * matches. Changing it replaces the rule.
   */
  protocol?: string | number;
  /**
   * Remote IP range (CIDR) the rule matches. Mutually exclusive with
   * `remoteSecurityGroupId`. Changing it replaces the rule.
   */
  ipRange?: string;
  /**
   * Remote security group whose members the rule matches. Mutually
   * exclusive with `ipRange`. Changing it replaces the rule.
   */
  remoteSecurityGroupId?: string;
  /**
   * Port range the rule matches (TCP and UDP only). When omitted, every
   * port matches. Changing it replaces the rule.
   */
  portRange?: SecurityGroupRulePortRange;
  /** ICMP type and code (ICMP only). Changing it replaces the rule. */
  icmpParameters?: SecurityGroupRuleIcmp;
  /** Free-text description. Changing it replaces the rule. */
  description?: string;
}

export interface SecurityGroupRuleAttributes {
  /** Rule id (UUID). */
  securityGroupRuleId: string;
  /** Security group the rule belongs to. */
  securityGroupId: string;
  /** Project of the security group. */
  projectId: string;
  /** Region of the security group. */
  region: string;
  /** Direction of the traffic the rule matches. */
  direction: string;
  /** Address family the rule matches. */
  ethertype: string;
  /** Protocol name, if the rule matches one protocol. */
  protocolName: string | undefined;
  /** IANA protocol number, if the rule matches one protocol. */
  protocolNumber: number | undefined;
  /** Remote IP range, if any. */
  ipRange: string | undefined;
  /** Remote security group, if any. */
  remoteSecurityGroupId: string | undefined;
  /** Port range, if the rule is restricted to one. */
  portRange: SecurityGroupRulePortRange | undefined;
  /** ICMP type and code, if any. */
  icmpParameters: SecurityGroupRuleIcmp | undefined;
  /** Description, if any. */
  description: string | undefined;
}

export type SecurityGroupRule = Resource<
  "Stackit.IaaS.SecurityGroupRule",
  SecurityGroupRuleProps,
  SecurityGroupRuleAttributes,
  never,
  Providers
>;

/**
 * A rule of a STACKIT {@link SecurityGroup}: allows ingress or egress
 * traffic matching a protocol, port range and remote address range or
 * security group.
 *
 * Rules are immutable: changing any property replaces the rule.
 *
 * Ownership: security group rules carry no labels. A rule is identified
 * by the id recorded in state; when that id is unknown (a create whose
 * state was never persisted) an existing rule with the same direction,
 * address family, protocol, remote, ports and description is taken over,
 * since STACKIT rejects such a rule as a duplicate. `alchemy unsafe nuke` does not list
 * rules: they are deleted with their security group.
 *
 * ### Allowing ingress traffic
 * **Example:** HTTPS from anywhere
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const web = yield* Stackit.IaaS.SecurityGroup("Web", {});
 * yield* Stackit.IaaS.SecurityGroupRule("WebHttps", {
 *   securityGroupId: web.securityGroupId,
 *   direction: "ingress",
 *   protocol: "tcp",
 *   portRange: { min: 443, max: 443 },
 *   ipRange: "0.0.0.0/0",
 * });
 * ```
 *
 * **Example:** Traffic from another security group
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const web = yield* Stackit.IaaS.SecurityGroup("Web", {});
 * const db = yield* Stackit.IaaS.SecurityGroup("Db", {});
 * yield* Stackit.IaaS.SecurityGroupRule("DbFromWeb", {
 *   securityGroupId: db.securityGroupId,
 *   direction: "ingress",
 *   protocol: "tcp",
 *   portRange: { min: 5432, max: 5432 },
 *   remoteSecurityGroupId: web.securityGroupId,
 * });
 * ```
 *
 * ### ICMP
 * **Example:** Allow ping
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const web = yield* Stackit.IaaS.SecurityGroup("Web", {});
 * yield* Stackit.IaaS.SecurityGroupRule("Ping", {
 *   securityGroupId: web.securityGroupId,
 *   direction: "ingress",
 *   protocol: "icmp",
 *   icmpParameters: { type: 8, code: 0 },
 *   ipRange: "0.0.0.0/0",
 * });
 * ```
 *
 * ### Replacement
 * Every property change replaces the rule. The new rule is created first,
 * so allowed traffic keeps flowing, except when only `description`
 * changes: STACKIT would reject the new rule as a duplicate, so the old
 * rule is deleted first.
 *
 * @resource
 * @product STACKIT Security Groups
 * @category IaaS
 */
export const SecurityGroupRule = Resource<SecurityGroupRule>("Stackit.IaaS.SecurityGroupRule");

type ObservedRule = iaas.SecurityGroupRule | iaas.GetSecurityGroupRuleResponse;

const toAttrs = (
  rule: ObservedRule,
  scope: ProjectScope,
  securityGroupId: string,
): SecurityGroupRuleAttributes => ({
  securityGroupRuleId: rule.id ?? "",
  securityGroupId,
  ...scope,
  direction: rule.direction,
  ethertype: rule.ethertype ?? "IPv4",
  protocolName: rule.protocol?.name,
  protocolNumber: rule.protocol?.number,
  ipRange: rule.ipRange,
  remoteSecurityGroupId: rule.remoteSecurityGroupId,
  portRange: rule.portRange === undefined ? undefined : { ...rule.portRange },
  icmpParameters: rule.icmpParameters === undefined ? undefined : { ...rule.icmpParameters },
  description: rule.description,
});

/** Whether an observed rule has the same effect as the desired one. */
const sameRule = (rule: ObservedRule, news: SecurityGroupRuleProps) => {
  if ((rule.description ?? "") !== (news.description ?? "")) return false;
  if (rule.direction !== news.direction) return false;
  if ((rule.ethertype ?? "IPv4") !== (news.ethertype ?? "IPv4")) return false;
  if (rule.ipRange !== news.ipRange) return false;
  if (rule.remoteSecurityGroupId !== news.remoteSecurityGroupId) return false;
  if (rule.portRange?.min !== news.portRange?.min || rule.portRange?.max !== news.portRange?.max) {
    return false;
  }
  if (
    rule.icmpParameters?.type !== news.icmpParameters?.type ||
    rule.icmpParameters?.code !== news.icmpParameters?.code
  ) {
    return false;
  }
  if (news.protocol === undefined) return rule.protocol === undefined;
  return typeof news.protocol === "number"
    ? rule.protocol?.number === news.protocol
    : rule.protocol?.name === news.protocol;
};

/** The rule's effect: everything except the description. */
const functionalKey = (props: SecurityGroupRuleProps) =>
  JSON.stringify([
    props.securityGroupId,
    props.direction,
    props.ethertype ?? "IPv4",
    props.protocol ?? null,
    props.ipRange ?? null,
    props.remoteSecurityGroupId ?? null,
    props.portRange?.min ?? null,
    props.portRange?.max ?? null,
    props.icmpParameters?.type ?? null,
    props.icmpParameters?.code ?? null,
  ]);

const getRule = (scope: ProjectScope, securityGroupId: string, securityGroupRuleId: string) =>
  iaas
    .getSecurityGroupRule({ ...scope, securityGroupId, securityGroupRuleId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

export const SecurityGroupRuleProvider = () =>
  Provider.succeed(SecurityGroupRule, {
    stables: ["securityGroupRuleId", "securityGroupId", "projectId", "region"],
    nuke: { dependsOn: ["Stackit.IaaS.SecurityGroup"] },

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      if (yield* projectScopeChanged(news, output)) return { action: "replace" } as const;
      // Rules have no update API: any change replaces.
      if (olds === undefined) return undefined;
      if (functionalKey(news) !== functionalKey(olds)) return { action: "replace" } as const;
      if ((news.description ?? "") !== (olds.description ?? "")) {
        // Same effect, new description: STACKIT rejects a duplicate rule, so
        // the old one goes first.
        return { action: "replace", deleteFirst: true } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output }) {
      // Without a recorded id there is no ownership marker to find the rule
      // by; reconcile takes over an identical rule instead.
      if (output === undefined) return undefined;
      const scope = { projectId: output.projectId, region: output.region };
      const observed = yield* getRule(scope, output.securityGroupId, output.securityGroupRuleId);
      return observed === undefined ? undefined : toAttrs(observed, scope, output.securityGroupId);
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const securityGroupId = news.securityGroupId;

      // Observe — by recorded id, else an identical rule (a duplicate create
      // would be rejected).
      // `output` is a cache: the recorded id only counts within the same group.
      const recordedId =
        output?.securityGroupId === securityGroupId ? output.securityGroupRuleId : undefined;
      let current: ObservedRule | undefined =
        recordedId === undefined ? undefined : yield* getRule(scope, securityGroupId, recordedId);
      if (current === undefined) {
        const { items } = yield* iaas.listSecurityGroupRules({ ...scope, securityGroupId });
        current = items.find((rule) => sameRule(rule, news));
      }

      // Ensure — existence-only: nothing to sync after create.
      if (current === undefined) {
        current = yield* iaas.createSecurityGroupRule({
          ...scope,
          securityGroupId,
          direction: news.direction,
          ethertype: news.ethertype,
          protocol: news.protocol,
          ipRange: news.ipRange,
          remoteSecurityGroupId: news.remoteSecurityGroupId,
          portRange: news.portRange,
          icmpParameters: news.icmpParameters,
          description: news.description,
        });
      }
      if (current.id === undefined) {
        return yield* new SecurityGroupRuleIdMissing({
          securityGroupId,
          message: `STACKIT returned a rule of security group ${securityGroupId} without an id`,
        });
      }
      return toAttrs(current, scope, securityGroupId);
    }),

    delete: Effect.fn(function* ({ output }) {
      const scope = { projectId: output.projectId, region: output.region };
      yield* iaas
        .deleteSecurityGroupRule({
          ...scope,
          securityGroupId: output.securityGroupId,
          securityGroupRuleId: output.securityGroupRuleId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone({
        resource: `STACKIT security group rule ${output.securityGroupRuleId}`,
        read: getRule(scope, output.securityGroupId, output.securityGroupRuleId),
        timeout: "1 minute",
      });
    }),
  });
