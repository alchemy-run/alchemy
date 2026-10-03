import * as Layer from "effect/Layer";
import { CaCertificate, CaCertificateProvider } from "./CaCertificate.ts";
import { Client, ClientProvider } from "./Client.ts";
import { ClientGroup, ClientGroupProvider } from "./ClientGroup.ts";
import { Domain, DomainProvider } from "./Domain.ts";
import {
  DomainEventSubscription,
  DomainEventSubscriptionProvider,
} from "./DomainEventSubscription.ts";
import { DomainTopic, DomainTopicProvider } from "./DomainTopic.ts";
import {
  DomainTopicEventSubscription,
  DomainTopicEventSubscriptionProvider,
} from "./DomainTopicEventSubscription.ts";
import {
  EventSubscription,
  EventSubscriptionProvider,
} from "./EventSubscription.ts";
import { Namespace, NamespaceProvider } from "./Namespace.ts";
import { NamespaceTopic, NamespaceTopicProvider } from "./NamespaceTopic.ts";
import {
  NamespaceTopicEventSubscription,
  NamespaceTopicEventSubscriptionProvider,
} from "./NamespaceTopicEventSubscription.ts";
import {
  PartnerConfiguration,
  PartnerConfigurationProvider,
} from "./PartnerConfiguration.ts";
import {
  PermissionBinding,
  PermissionBindingProvider,
} from "./PermissionBinding.ts";
import { SystemTopic, SystemTopicProvider } from "./SystemTopic.ts";
import {
  SystemTopicEventSubscription,
  SystemTopicEventSubscriptionProvider,
} from "./SystemTopicEventSubscription.ts";
import { Topic, TopicProvider } from "./Topic.ts";
import {
  TopicEventSubscription,
  TopicEventSubscriptionProvider,
} from "./TopicEventSubscription.ts";
import { TopicSpace, TopicSpaceProvider } from "./TopicSpace.ts";

export const resources = [
  CaCertificate,
  Client,
  ClientGroup,
  Domain,
  DomainEventSubscription,
  DomainTopic,
  DomainTopicEventSubscription,
  EventSubscription,
  Namespace,
  NamespaceTopic,
  NamespaceTopicEventSubscription,
  PartnerConfiguration,
  PermissionBinding,
  SystemTopic,
  SystemTopicEventSubscription,
  Topic,
  TopicEventSubscription,
  TopicSpace,
];
export const layers = () =>
  Layer.mergeAll(
    CaCertificateProvider(),
    ClientProvider(),
    ClientGroupProvider(),
    DomainProvider(),
    DomainEventSubscriptionProvider(),
    DomainTopicProvider(),
    DomainTopicEventSubscriptionProvider(),
    EventSubscriptionProvider(),
    NamespaceProvider(),
    NamespaceTopicProvider(),
    NamespaceTopicEventSubscriptionProvider(),
    PartnerConfigurationProvider(),
    PermissionBindingProvider(),
    SystemTopicProvider(),
    SystemTopicEventSubscriptionProvider(),
    TopicProvider(),
    TopicEventSubscriptionProvider(),
    TopicSpaceProvider(),
  );
