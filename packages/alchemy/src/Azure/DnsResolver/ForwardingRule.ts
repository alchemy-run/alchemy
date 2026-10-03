import * as dnsresolver from "@distilled.cloud/azure/dnsresolver";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { createDnsResolverName, FAST_BUDGET, sameArm } from "./Common.ts";

export type ForwardingRuleState = "Enabled" | "Disabled";

export interface TargetDnsServer {
  /** IP address of the DNS server. */
  ipAddress: string;
  /**
   * Port of the DNS server. Azure currently only accepts `53`.
   * @default 53
   */
  port?: number;
}

export interface ForwardingRuleProps {
  /**
   * Resource group of the ruleset. The DNS resolver API rejects resource group names
   * longer than 80 characters. Changing it replaces the rule.
   */
  resourceGroup: string;
  /** Name of the DNS forwarding ruleset that holds the rule. Changing it replaces the rule. */
  dnsForwardingRuleset: string;
  /**
   * Rule name: 1-80 letters, digits, `_`, and `-`. If omitted, a unique
   * name is generated from the app, stage, and logical ID. Changing it
   * replaces the rule.
   */
  name?: string;
  /**
   * Fully qualified domain the rule matches, ending with a dot (e.g.
   * `corp.example.com.`). Use `.` to match every query. Changing it
   * replaces the rule.
   */
  domainName: string;
  /** DNS servers matching queries are forwarded to. */
  targetDnsServers: TargetDnsServer[];
  /**
   * Whether the rule is applied.
   * @default "Enabled"
   */
  forwardingRuleState?: ForwardingRuleState;
  /**
   * User metadata. Alchemy ownership markers (`alchemy::stack`,
   * `alchemy::stage`, `alchemy::id`) are merged in because forwarding
   * rules have no tags.
   */
  metadata?: Record<string, string>;
}

export interface ForwardingRule extends Resource<
  "Azure.DnsResolver.ForwardingRule",
  ForwardingRuleProps,
  {
    /** Name of the rule. */
    forwardingRuleName: string;
    /** ARM resource ID of the rule. */
    forwardingRuleId: string;
    /** Name of the ruleset that holds the rule. */
    dnsForwardingRuleset: string;
    /** Resource group of the ruleset. */
    resourceGroup: string;
    /** Domain the rule matches. */
    domainName: string;
    /** DNS servers matching queries are forwarded to. */
    targetDnsServers: { ipAddress: string; port: number }[];
    /** Whether the rule is applied. */
    forwardingRuleState: string;
    /** User metadata (Alchemy ownership markers stripped). */
    metadata: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A conditional forwarding rule in an Azure DNS forwarding ruleset: queries
 * for `domainName` from linked virtual networks are forwarded to
 * `targetDnsServers` through the ruleset's outbound endpoints.
 *
 * Forwarding rules cannot be tagged, so Alchemy records ownership in the
 * rule's metadata.
 *
 * @see https://learn.microsoft.com/azure/dns/private-resolver-endpoints-rulesets#rules
 *
 * ### Creating a Rule
 * **Example:** Forward a domain to on-premises DNS
 * ```typescript
 * const rule = yield* Azure.DnsResolver.ForwardingRule("corp", {
 *   resourceGroup: group.resourceGroupName,
 *   dnsForwardingRuleset: ruleset.dnsForwardingRulesetName,
 *   domainName: "corp.example.com.",
 *   targetDnsServers: [
 *     { ipAddress: "10.10.0.4" },
 *     { ipAddress: "10.10.0.5", port: 53 },
 *   ],
 * });
 * ```
 *
 * **Example:** Disabled rule
 * ```typescript
 * const rule = yield* Azure.DnsResolver.ForwardingRule("legacy", {
 *   resourceGroup: group.resourceGroupName,
 *   dnsForwardingRuleset: ruleset.dnsForwardingRulesetName,
 *   domainName: "legacy.example.com.",
 *   targetDnsServers: [{ ipAddress: "10.10.0.4" }],
 *   forwardingRuleState: "Disabled",
 * });
 * ```
 *
 * @resource
 */
export const ForwardingRule = Resource<ForwardingRule>(
  "Azure.DnsResolver.ForwardingRule",
);

const getRule = (
  subscriptionId: string,
  resourceGroupName: string,
  dnsForwardingRulesetName: string,
  forwardingRuleName: string,
) =>
  orUndefinedIfNotFound(
    dnsresolver.GetForwardingRule({
      subscriptionId,
      resourceGroupName,
      dnsForwardingRulesetName,
      forwardingRuleName,
    }),
  );

const normalizeServers = (servers: ReadonlyArray<TargetDnsServer>) =>
  servers.map((server) => ({
    ipAddress: server.ipAddress,
    port: server.port ?? 53,
  }));

const sameServers = (
  a: ReadonlyArray<TargetDnsServer>,
  b: ReadonlyArray<TargetDnsServer>,
) =>
  JSON.stringify(normalizeServers(a)) === JSON.stringify(normalizeServers(b));

const toAttrs = (
  resourceGroup: string,
  rulesetName: string,
  name: string,
  rule: dnsresolver.GetForwardingRuleResponse | dnsresolver.ForwardingRule,
): ForwardingRule["Attributes"] => ({
  forwardingRuleName: name,
  forwardingRuleId: rule.id ?? "",
  dnsForwardingRuleset: rulesetName,
  resourceGroup,
  domainName: rule.properties.domainName,
  targetDnsServers: normalizeServers(rule.properties.targetDnsServers),
  forwardingRuleState: rule.properties.forwardingRuleState ?? "Enabled",
  metadata: userTags(rule.properties.metadata),
});

export const ForwardingRuleProvider = () =>
  Provider.succeed(ForwardingRule, {
    stables: [
      "forwardingRuleName",
      "forwardingRuleId",
      "dnsForwardingRuleset",
      "resourceGroup",
      "domainName",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const rulesets = yield* dnsresolver
        .ListDnsForwardingRulesets({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListDnsForwardingRulesets", page),
          ),
        );
      const found: ForwardingRule["Attributes"][] = [];
      for (const ruleset of rulesets.value ?? []) {
        const group = resourceGroupOf(ruleset.id);
        if (group === undefined || ruleset.name === undefined) continue;
        const page = yield* orUndefinedIfNotFound(
          dnsresolver.ListForwardingRules({
            subscriptionId,
            resourceGroupName: group,
            dnsForwardingRulesetName: ruleset.name,
          }),
        );
        if (page !== undefined) {
          yield* requireSinglePage("ListForwardingRules", page);
        }
        for (const rule of page?.value ?? []) {
          if (
            hasAnyAlchemyTag(rule.properties.metadata) &&
            rule.name !== undefined
          ) {
            found.push(toAttrs(group, ruleset.name, rule.name, rule));
          }
        }
      }
      return found;
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const sameDomain =
        news.domainName.toLowerCase() === output.domainName.toLowerCase();
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.dnsForwardingRuleset, output.dnsForwardingRuleset) ||
        (news.name !== undefined && news.name !== output.forwardingRuleName) ||
        !sameDomain
      ) {
        // A domain can appear only once per ruleset.
        return {
          action: "replace",
          deleteFirst:
            sameDomain &&
            sameArm(news.dnsForwardingRuleset, output.dnsForwardingRuleset),
        } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const rulesetName =
        output?.dnsForwardingRuleset ?? olds?.dnsForwardingRuleset;
      if (resourceGroup === undefined || rulesetName === undefined) {
        return undefined;
      }
      const name =
        output?.forwardingRuleName ??
        olds?.name ??
        (yield* createDnsResolverName(id));
      const observed = yield* getRule(
        subscriptionId,
        resourceGroup,
        rulesetName,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, rulesetName, name, observed);
      return (yield* isOwned(id, observed.properties.metadata))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Network");
      const { resourceGroup, dnsForwardingRuleset: rulesetName } = news;
      const name =
        news.name ??
        output?.forwardingRuleName ??
        (yield* createDnsResolverName(id));
      const metadata = yield* desiredTags(id, news.metadata);
      const state = news.forwardingRuleState ?? "Enabled";
      const targetDnsServers = normalizeServers(news.targetDnsServers);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        dnsForwardingRulesetName: rulesetName,
        forwardingRuleName: name,
      };
      const get = getRule(subscriptionId, resourceGroup, rulesetName, name);

      // Observe.
      const observed = yield* get;

      // Ensure. Rule creation is synchronous.
      if (observed === undefined) {
        yield* dnsresolver.ForwardingRulesCreateOrUpdate({
          ...where,
          properties: {
            domainName: news.domainName,
            targetDnsServers,
            metadata,
            forwardingRuleState: state,
          },
        });
      } else {
        // Sync mutable aspects against the observed rule; PATCH only deltas.
        const serversChanged = !sameServers(
          observed.properties.targetDnsServers,
          targetDnsServers,
        );
        const stateChanged =
          (observed.properties.forwardingRuleState ?? "Enabled") !== state;
        const metadataChanged = tagsDiffer(
          observed.properties.metadata,
          metadata,
        );
        if (serversChanged || stateChanged || metadataChanged) {
          yield* dnsresolver.UpdateForwardingRule({
            ...where,
            properties: {
              targetDnsServers: serversChanged ? targetDnsServers : undefined,
              forwardingRuleState: stateChanged ? state : undefined,
              metadata: metadataChanged ? metadata : undefined,
            },
          });
        }
      }

      const fresh = yield* waitForProvisioned(
        `DNS forwarding rule ${name}`,
        get,
        (rule) =>
          !sameServers(rule.properties.targetDnsServers, targetDnsServers) ||
          (rule.properties.forwardingRuleState ?? "Enabled") !== state ||
          tagsDiffer(rule.properties.metadata, metadata)
            ? "Updating"
            : rule.properties.provisioningState,
        FAST_BUDGET,
      );
      return toAttrs(resourceGroup, rulesetName, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        dnsresolver.DeleteForwardingRule({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          dnsForwardingRulesetName: output.dnsForwardingRuleset,
          forwardingRuleName: output.forwardingRuleName,
        }),
      );
      yield* waitUntilGone(
        `DNS forwarding rule ${output.forwardingRuleName}`,
        getRule(
          subscriptionId,
          output.resourceGroup,
          output.dnsForwardingRuleset,
          output.forwardingRuleName,
        ),
        FAST_BUDGET,
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.DnsResolver.ForwardingRuleset",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
