import * as network from "@distilled.cloud/azure/network";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { sameSet } from "./common.ts";
import { networkProvider } from "./generic.ts";
import { perimeterTags } from "./networkSecurityPerimeterShared.ts";

export interface NetworkSecurityPerimeterAccessRuleProps {
  /** Resource group of the perimeter. Changing it replaces the perimeter access rule. */
  resourceGroup: string;
  /** Name of the parent network security perimeter. Changing it replaces the perimeter access rule. */
  networkSecurityPerimeter: string;
  /** Name of the parent perimeter profile. Changing it replaces the perimeter access rule. */
  profile: string;
  /**
   * Name of the perimeter access rule. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the perimeter access rule.
   */
  name?: string;
  /**
   * Direction. Changing it replaces the rule.
   * @default "Inbound"
   */
  direction?: "Inbound" | "Outbound";
  /** Inbound: allowed source CIDRs. */
  addressPrefixes?: string[];
  /** Inbound: allowed subscription IDs (`/subscriptions/<id>`). */
  subscriptions?: string[];
  /** Inbound: allowed service tags. */
  serviceTags?: string[];
  /** Outbound: allowed FQDNs. */
  fullyQualifiedDomainNames?: string[];
  /** Outbound: allowed email addresses. */
  emailAddresses?: string[];
  /** Outbound: allowed phone numbers. */
  phoneNumbers?: string[];
}

export interface NetworkSecurityPerimeterAccessRule extends Resource<
  "Azure.Network.NetworkSecurityPerimeterAccessRule",
  NetworkSecurityPerimeterAccessRuleProps,
  {
    /** Name of the perimeter access rule. */
    accessRuleName: string;
    /** ARM resource ID of the perimeter access rule. */
    accessRuleId: string;
    /** Name of the parent network security perimeter. */
    networkSecurityPerimeter: string;
    /** Name of the parent perimeter profile. */
    profile: string;
    /** Resource group of the perimeter. */
    resourceGroup: string;
    /** Direction. */
    direction: string | undefined;
    /** Allowed source CIDRs. */
    addressPrefixes: string[];
    /** Allowed FQDNs. */
    fullyQualifiedDomainNames: string[];
  },
  never,
  Providers
> {}

/**
 * An access rule in an Azure network security perimeter profile — the
 * inbound sources (CIDRs, subscriptions, service tags) or outbound
 * destinations (FQDNs) allowed across the perimeter. It carries no tags:
 * ownership follows the perimeter.
 *
 * @see https://learn.microsoft.com/azure/private-link/network-security-perimeter-concepts
 *
 * ### Creating Access Rules
 * **Example:** Allow an office range inbound
 * ```typescript
 * yield* Azure.Network.NetworkSecurityPerimeterAccessRule("office", {
 *   resourceGroup: group.resourceGroupName,
 *   networkSecurityPerimeter: perimeter.networkSecurityPerimeterName,
 *   profile: profile.profileName,
 *   direction: "Inbound",
 *   addressPrefixes: ["203.0.113.0/24"],
 * });
 * ```
 *
 * @resource
 */
export const NetworkSecurityPerimeterAccessRule =
  Resource<NetworkSecurityPerimeterAccessRule>(
    "Azure.Network.NetworkSecurityPerimeterAccessRule",
  );

export const NetworkSecurityPerimeterAccessRuleProvider = () =>
  Provider.succeed(
    NetworkSecurityPerimeterAccessRule,
    networkProvider<NetworkSecurityPerimeterAccessRule>()({
      label: "perimeter access rule",
      nameAttr: "accessRuleName",
      parents: ["networkSecurityPerimeter", "profile"],
      tracked: false,
      immutable: (news, output) =>
        (news.direction ?? "Inbound") !== (output.direction ?? "Inbound"),
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetNetworkSecurityPerimeterAccessRule({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            networkSecurityPerimeterName: path.networkSecurityPerimeter!,
            profileName: path.profile!,
            accessRuleName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.NetworkSecurityPerimeterAccessRulesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkSecurityPerimeterName: path.networkSecurityPerimeter!,
          profileName: path.profile!,
          accessRuleName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteNetworkSecurityPerimeterAccessRule({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkSecurityPerimeterName: path.networkSecurityPerimeter!,
          profileName: path.profile!,
          accessRuleName: path.name,
        }),
      ownerTags: perimeterTags,
      body: (news) => ({
        properties: {
          direction: news.direction ?? "Inbound",
          addressPrefixes: news.addressPrefixes ?? [],
          subscriptions: (news.subscriptions ?? []).map((id) => ({ id })),
          serviceTags: news.serviceTags ?? [],
          fullyQualifiedDomainNames: news.fullyQualifiedDomainNames ?? [],
          emailAddresses: news.emailAddresses ?? [],
          phoneNumbers: news.phoneNumbers ?? [],
        },
      }),
      drifted: (observed, _body, news) => {
        const p = observed.properties;
        return (
          !sameSet(p?.addressPrefixes, news.addressPrefixes) ||
          !sameSet(
            (p?.subscriptions ?? []).flatMap((s) => (s.id ? [s.id] : [])),
            news.subscriptions,
          ) ||
          !sameSet(p?.serviceTags, news.serviceTags) ||
          !sameSet(
            p?.fullyQualifiedDomainNames,
            news.fullyQualifiedDomainNames,
          ) ||
          !sameSet(p?.emailAddresses, news.emailAddresses) ||
          !sameSet(p?.phoneNumbers, news.phoneNumbers)
        );
      },
      toAttrs: (path, observed) => ({
        accessRuleName: path.name,
        accessRuleId: observed.id ?? "",
        networkSecurityPerimeter: path.networkSecurityPerimeter!,
        profile: path.profile!,
        resourceGroup: path.resourceGroup,
        direction: observed.properties?.direction,
        addressPrefixes: [...(observed.properties?.addressPrefixes ?? [])],
        fullyQualifiedDomainNames: [
          ...(observed.properties?.fullyQualifiedDomainNames ?? []),
        ],
      }),
      dependsOn: [
        "Azure.Network.NetworkSecurityPerimeterProfile",
        "Azure.Network.NetworkSecurityPerimeter",
      ],
    }),
  );
