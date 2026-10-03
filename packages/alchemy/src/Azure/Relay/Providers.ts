import * as Layer from "effect/Layer";
import {
  HybridConnection,
  HybridConnectionProvider,
} from "./HybridConnection.ts";
import {
  HybridConnectionAuthorizationRule,
  HybridConnectionAuthorizationRuleProvider,
} from "./HybridConnectionAuthorizationRule.ts";
import { Namespace, NamespaceProvider } from "./Namespace.ts";
import {
  NamespaceAuthorizationRule,
  NamespaceAuthorizationRuleProvider,
} from "./NamespaceAuthorizationRule.ts";
import { NetworkRuleSet, NetworkRuleSetProvider } from "./NetworkRuleSet.ts";
import {
  PrivateEndpointConnection,
  PrivateEndpointConnectionProvider,
} from "./PrivateEndpointConnection.ts";
import { WcfRelay, WcfRelayProvider } from "./WcfRelay.ts";
import {
  WcfRelayAuthorizationRule,
  WcfRelayAuthorizationRuleProvider,
} from "./WcfRelayAuthorizationRule.ts";

export const resources = [
  HybridConnection,
  HybridConnectionAuthorizationRule,
  Namespace,
  NamespaceAuthorizationRule,
  NetworkRuleSet,
  PrivateEndpointConnection,
  WcfRelay,
  WcfRelayAuthorizationRule,
];
export const layers = () =>
  Layer.mergeAll(
    HybridConnectionProvider(),
    HybridConnectionAuthorizationRuleProvider(),
    NamespaceProvider(),
    NamespaceAuthorizationRuleProvider(),
    NetworkRuleSetProvider(),
    PrivateEndpointConnectionProvider(),
    WcfRelayProvider(),
    WcfRelayAuthorizationRuleProvider(),
  );
