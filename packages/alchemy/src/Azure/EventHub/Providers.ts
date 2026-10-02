import * as Layer from "effect/Layer";
import { ApplicationGroup, ApplicationGroupProvider } from "./ApplicationGroup.ts";
import { Cluster, ClusterProvider } from "./Cluster.ts";
import { ConsumerGroup, ConsumerGroupProvider } from "./ConsumerGroup.ts";
import {
  DisasterRecoveryConfig,
  DisasterRecoveryConfigProvider,
} from "./DisasterRecoveryConfig.ts";
import { EventHub, EventHubProvider } from "./EventHub.ts";
import {
  EventHubAuthorizationRule,
  EventHubAuthorizationRuleProvider,
} from "./EventHubAuthorizationRule.ts";
import { Namespace, NamespaceProvider } from "./Namespace.ts";
import {
  NamespaceAuthorizationRule,
  NamespaceAuthorizationRuleProvider,
} from "./NamespaceAuthorizationRule.ts";
import { NetworkRuleSet, NetworkRuleSetProvider } from "./NetworkRuleSet.ts";
import { SchemaGroup, SchemaGroupProvider } from "./SchemaGroup.ts";

export const resources = [
  ApplicationGroup,
  Cluster,
  ConsumerGroup,
  DisasterRecoveryConfig,
  EventHub,
  EventHubAuthorizationRule,
  Namespace,
  NamespaceAuthorizationRule,
  NetworkRuleSet,
  SchemaGroup,
];
export const layers = () =>
  Layer.mergeAll(
    ApplicationGroupProvider(),
    ClusterProvider(),
    ConsumerGroupProvider(),
    DisasterRecoveryConfigProvider(),
    EventHubProvider(),
    EventHubAuthorizationRuleProvider(),
    NamespaceProvider(),
    NamespaceAuthorizationRuleProvider(),
    NetworkRuleSetProvider(),
    SchemaGroupProvider(),
  );
