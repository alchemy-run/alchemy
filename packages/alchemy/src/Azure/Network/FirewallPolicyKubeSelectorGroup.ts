import * as network from "@distilled.cloud/azure/network";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { canonical } from "./common.ts";
import { networkProvider } from "./generic.ts";

/** A Kubernetes label selector requirement. */
export interface KubeLabelSelectorExpression {
  /** Label key (≤ 63 alphanumerics, `-`, `_`, `.`). */
  key: string;
  /** Relationship between the key and the values. */
  operator: "In" | "NotIn" | "Exists" | "DoesNotExist";
  /**
   * Values (non-empty for `In`/`NotIn`, empty for `Exists`/`DoesNotExist`).
   */
  values?: string[];
}

/** A Kubernetes label selector (all requirements are ANDed). */
export interface KubeLabelSelector {
  /** Exact `key: value` label matches. */
  matchLabels?: Record<string, string>;
  /** Label selector requirements. */
  matchExpressions?: KubeLabelSelectorExpression[];
}

export interface FirewallPolicyKubeSelectorGroupProps {
  /** Resource group of the firewall policy. Changing it replaces the group. */
  resourceGroup: string;
  /** Name of the parent firewall policy. Changing it replaces the group. */
  firewallPolicy: string;
  /**
   * Name of the selector group. If omitted, a unique name is generated
   * from the app, stage, and logical ID. Changing it replaces the group.
   */
  name?: string;
  /** Pods the group matches. */
  podSelector?: KubeLabelSelector;
  /** Namespaces the group matches. */
  namespaceSelector?: KubeLabelSelector;
}

export interface FirewallPolicyKubeSelectorGroup extends Resource<
  "Azure.Network.FirewallPolicyKubeSelectorGroup",
  FirewallPolicyKubeSelectorGroupProps,
  {
    /** Name of the selector group. */
    kubeSelectorGroupName: string;
    /** ARM resource ID of the selector group. */
    kubeSelectorGroupId: string;
    /** Name of the parent firewall policy. */
    firewallPolicy: string;
    /** Resource group of the firewall policy. */
    resourceGroup: string;
    /** Pods the group matches. */
    podSelector: KubeLabelSelector | undefined;
    /** Namespaces the group matches. */
    namespaceSelector: KubeLabelSelector | undefined;
  },
  never,
  Providers
> {}

/**
 * A Kubernetes selector group on an Azure firewall policy — a named set of
 * AKS pods/namespaces (label selectors) that firewall rules can reference
 * as sources or destinations (preview). Selector groups carry no tags:
 * ownership follows the parent policy.
 *
 * @see https://learn.microsoft.com/azure/firewall/firewall-preview
 *
 * ### Creating a Selector Group
 * **Example:** Pods labelled `app=web` in the `prod` namespace
 * ```typescript
 * yield* Azure.Network.FirewallPolicyKubeSelectorGroup("web", {
 *   resourceGroup: group.resourceGroupName,
 *   firewallPolicy: policy.firewallPolicyName,
 *   podSelector: { matchLabels: { app: "web" } },
 *   namespaceSelector: {
 *     matchExpressions: [
 *       { key: "kubernetes.io/metadata.name", operator: "In", values: ["prod"] },
 *     ],
 *   },
 * });
 * ```
 *
 * @resource
 */
export const FirewallPolicyKubeSelectorGroup =
  Resource<FirewallPolicyKubeSelectorGroup>(
    "Azure.Network.FirewallPolicyKubeSelectorGroup",
  );

const toSelector = (
  selector: network.KubeLabelSelector | undefined,
): KubeLabelSelector | undefined =>
  selector === undefined
    ? undefined
    : {
        matchLabels:
          selector.matchLabels === undefined
            ? undefined
            : Object.fromEntries(
                Object.entries(selector.matchLabels).flatMap(([k, v]) =>
                  v === undefined ? [] : [[k, v]],
                ),
              ),
        matchExpressions: selector.matchExpressions?.map((e) => ({
          key: e.key ?? "",
          operator: (e.operator ??
            "In") as KubeLabelSelectorExpression["operator"],
          values: e.values === undefined ? undefined : [...e.values],
        })),
      };

/** Comparable form: empty collections are the same as absent ones. */
const normalize = (selector: KubeLabelSelector | undefined) =>
  canonical({
    matchLabels:
      selector?.matchLabels && Object.keys(selector.matchLabels).length > 0
        ? selector.matchLabels
        : undefined,
    matchExpressions: selector?.matchExpressions?.length
      ? selector.matchExpressions.map((e) => ({
          key: e.key,
          operator: e.operator,
          values: e.values?.length ? e.values : undefined,
        }))
      : undefined,
  });

export const FirewallPolicyKubeSelectorGroupProvider = () =>
  Provider.succeed(
    FirewallPolicyKubeSelectorGroup,
    networkProvider<FirewallPolicyKubeSelectorGroup>()({
      label: "firewall policy Kubernetes selector group",
      nameAttr: "kubeSelectorGroupName",
      parents: ["firewallPolicy"],
      tracked: false,
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetFirewallPolicyKubeSelectorGroup({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            firewallPolicyName: path.firewallPolicy!,
            kubeSelectorGroupName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.FirewallPolicyKubeSelectorGroupsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          firewallPolicyName: path.firewallPolicy!,
          kubeSelectorGroupName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteFirewallPolicyKubeSelectorGroup({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          firewallPolicyName: path.firewallPolicy!,
          kubeSelectorGroupName: path.name,
        }),
      ownerTags: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetFirewallPolicy({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            firewallPolicyName: path.firewallPolicy!,
          }),
        ).pipe(Effect.map((policy) => policy?.tags)),
      body: (news) => ({
        properties: {
          podSelector: news.podSelector,
          namespaceSelector: news.namespaceSelector,
        },
      }),
      drifted: (observed, _body, news) =>
        normalize(toSelector(observed.properties?.podSelector)) !==
          normalize(news.podSelector) ||
        normalize(toSelector(observed.properties?.namespaceSelector)) !==
          normalize(news.namespaceSelector),
      toAttrs: (path, observed) => ({
        kubeSelectorGroupName: path.name,
        kubeSelectorGroupId: observed.id ?? "",
        firewallPolicy: path.firewallPolicy!,
        resourceGroup: path.resourceGroup,
        podSelector: toSelector(observed.properties?.podSelector),
        namespaceSelector: toSelector(observed.properties?.namespaceSelector),
      }),
      dependsOn: ["Azure.Network.FirewallPolicy"],
    }),
  );
