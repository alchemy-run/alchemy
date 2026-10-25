import * as network from "@distilled.cloud/azure/network";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import { collectAll, orUndefinedIfNotFound, userTags } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { canonical } from "./common.ts";
import { idsOf, networkProvider } from "./generic.ts";

/** A traffic-threshold detection rule of a DDoS custom policy. */
export interface DdosDetectionRule {
  /** Name of the rule, unique within the policy. */
  name: string;
  /** Traffic the rule counts. */
  trafficType: "Tcp" | "Udp" | "TcpSyn";
  /** Packets per second above which mitigation starts. */
  packetsPerSecond: number;
}

export interface DdosCustomPolicyProps {
  /** Resource group of the policy. Changing it replaces the policy. */
  resourceGroup: string;
  /**
   * Name of the policy: 1-80 letters, digits, `_`, `.`, and `-`. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the policy.
   */
  name?: string;
  /**
   * Azure location. Changing it replaces the policy.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Detection rules that override the default mitigation thresholds.
   * @default []
   */
  detectionRules?: DdosDetectionRule[];
  /** User tags. Alchemy ownership tags are merged in automatically. */
  tags?: Record<string, string>;
}

export interface DdosCustomPolicy extends Resource<
  "Azure.Network.DdosCustomPolicy",
  DdosCustomPolicyProps,
  {
    /** Name of the policy. */
    ddosCustomPolicyName: string;
    /** ARM resource ID of the policy. */
    ddosCustomPolicyId: string;
    /** Resource group of the policy. */
    resourceGroup: string;
    /** Location of the policy. */
    location: string;
    /** Names of the policy's detection rules. */
    detectionRuleNames: string[];
    /** IDs of the frontend IP configurations that use the policy. */
    frontendIpConfigurationIds: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure DDoS custom policy (`Microsoft.Network/ddosCustomPolicies`) —
 * per-protocol packet-rate thresholds that tune when DDoS Protection
 * starts mitigating traffic for the frontends that reference the policy.
 * The policy itself is free.
 *
 * @see https://learn.microsoft.com/azure/ddos-protection/ddos-protection-overview
 *
 * ### Creating a Custom Policy
 * **Example:** Lower the SYN-flood threshold
 * ```typescript
 * const policy = yield* Azure.Network.DdosCustomPolicy("ddos", {
 *   detectionRules: [
 *     { name: "syn", trafficType: "TcpSyn", packetsPerSecond: 10000 },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const DdosCustomPolicy = GroupedResource<DdosCustomPolicy>("Azure.Network.DdosCustomPolicy");

const ruleKey = (
  rules: ReadonlyArray<{ name: string; trafficType: string; packetsPerSecond: number }>,
) =>
  canonical(
    [...rules]
      .map((r) => ({
        name: r.name.toLowerCase(),
        trafficType: r.trafficType.toLowerCase(),
        packetsPerSecond: r.packetsPerSecond,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );

export const DdosCustomPolicyProvider = () =>
  Provider.succeed(
    DdosCustomPolicy,
    networkProvider<DdosCustomPolicy>()({
      label: "DDoS custom policy",
      nameAttr: "ddosCustomPolicyName",
      tracked: true,
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetDdosCustomPolicy({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            ddosCustomPolicyName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.DdosCustomPoliciesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          ddosCustomPolicyName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteDdosCustomPolicy({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          ddosCustomPolicyName: path.name,
        }),
      updateTags: (subscriptionId, path, tags) =>
        network.UpdateDdosCustomPolicyTags({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          ddosCustomPolicyName: path.name,
          tags,
        }),
      listAll: (subscriptionId) => collectAll(network.ListDdosCustomPolicyAll, { subscriptionId }),
      body: (news, { location, tags }) => ({
        location,
        tags,
        properties: {
          detectionRules: (news.detectionRules ?? []).map((rule) => ({
            name: rule.name,
            properties: {
              detectionMode: "TrafficThreshold",
              trafficDetectionRule: {
                trafficType: rule.trafficType,
                packetsPerSecond: rule.packetsPerSecond,
              },
            },
          })),
        },
      }),
      drifted: (observed, _body, news) =>
        ruleKey(
          (observed.properties?.detectionRules ?? []).map((rule) => ({
            name: rule.name ?? "",
            trafficType: rule.properties?.trafficDetectionRule?.trafficType ?? "",
            packetsPerSecond: rule.properties?.trafficDetectionRule?.packetsPerSecond ?? 0,
          })),
        ) !== ruleKey(news.detectionRules ?? []),
      toAttrs: (path, observed) => ({
        ddosCustomPolicyName: path.name,
        ddosCustomPolicyId: observed.id ?? "",
        resourceGroup: path.resourceGroup,
        location: observed.location ?? "",
        detectionRuleNames: (observed.properties?.detectionRules ?? []).flatMap((rule) =>
          rule.name === undefined ? [] : [rule.name],
        ),
        frontendIpConfigurationIds: idsOf(observed.properties?.frontEndIpConfiguration),
        tags: userTags(observed.tags),
      }),
    }),
  );
