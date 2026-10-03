import * as Layer from "effect/Layer";
import { DnsResolver, DnsResolverProvider } from "./DnsResolver.ts";
import { DomainList, DomainListProvider } from "./DomainList.ts";
import { ForwardingRule, ForwardingRuleProvider } from "./ForwardingRule.ts";
import {
  ForwardingRuleset,
  ForwardingRulesetProvider,
} from "./ForwardingRuleset.ts";
import {
  ForwardingRulesetVirtualNetworkLink,
  ForwardingRulesetVirtualNetworkLinkProvider,
} from "./ForwardingRulesetVirtualNetworkLink.ts";
import { InboundEndpoint, InboundEndpointProvider } from "./InboundEndpoint.ts";
import {
  OutboundEndpoint,
  OutboundEndpointProvider,
} from "./OutboundEndpoint.ts";
import { Policy, PolicyProvider } from "./Policy.ts";
import {
  PolicyVirtualNetworkLink,
  PolicyVirtualNetworkLinkProvider,
} from "./PolicyVirtualNetworkLink.ts";
import { SecurityRule, SecurityRuleProvider } from "./SecurityRule.ts";

export const resources = [
  DnsResolver,
  DomainList,
  ForwardingRule,
  ForwardingRuleset,
  ForwardingRulesetVirtualNetworkLink,
  InboundEndpoint,
  OutboundEndpoint,
  Policy,
  PolicyVirtualNetworkLink,
  SecurityRule,
];
export const layers = () =>
  Layer.mergeAll(
    DnsResolverProvider(),
    DomainListProvider(),
    ForwardingRuleProvider(),
    ForwardingRulesetProvider(),
    ForwardingRulesetVirtualNetworkLinkProvider(),
    InboundEndpointProvider(),
    OutboundEndpointProvider(),
    PolicyProvider(),
    PolicyVirtualNetworkLinkProvider(),
    SecurityRuleProvider(),
  );
