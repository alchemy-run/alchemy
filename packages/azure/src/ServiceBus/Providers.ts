import * as Layer from "effect/Layer";
import {
  DisasterRecoveryConfig,
  DisasterRecoveryConfigProvider,
} from "./DisasterRecoveryConfig.ts";
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
import { Queue, QueueProvider } from "./Queue.ts";
import {
  QueueAuthorizationRule,
  QueueAuthorizationRuleProvider,
} from "./QueueAuthorizationRule.ts";
import { Rule, RuleProvider } from "./Rule.ts";
import { Subscription, SubscriptionProvider } from "./Subscription.ts";
import { Topic, TopicProvider } from "./Topic.ts";
import {
  TopicAuthorizationRule,
  TopicAuthorizationRuleProvider,
} from "./TopicAuthorizationRule.ts";

export const resources = [
  DisasterRecoveryConfig,
  Namespace,
  NamespaceAuthorizationRule,
  NetworkRuleSet,
  PrivateEndpointConnection,
  Queue,
  QueueAuthorizationRule,
  Rule,
  Subscription,
  Topic,
  TopicAuthorizationRule,
];
export const layers = () =>
  Layer.mergeAll(
    DisasterRecoveryConfigProvider(),
    NamespaceProvider(),
    NamespaceAuthorizationRuleProvider(),
    NetworkRuleSetProvider(),
    PrivateEndpointConnectionProvider(),
    QueueProvider(),
    QueueAuthorizationRuleProvider(),
    RuleProvider(),
    SubscriptionProvider(),
    TopicProvider(),
    TopicAuthorizationRuleProvider(),
  );
