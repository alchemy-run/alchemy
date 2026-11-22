import * as Layer from "effect/Layer";
import { Namespace, NamespaceProvider } from "./Namespace.ts";
import {
  NamespaceAuthorizationRule,
  NamespaceAuthorizationRuleProvider,
} from "./NamespaceAuthorizationRule.ts";
import { NotificationHub, NotificationHubProvider } from "./NotificationHub.ts";
import {
  NotificationHubAuthorizationRule,
  NotificationHubAuthorizationRuleProvider,
} from "./NotificationHubAuthorizationRule.ts";

export const resources = [
  Namespace,
  NamespaceAuthorizationRule,
  NotificationHub,
  NotificationHubAuthorizationRule,
];
export const layers = () =>
  Layer.mergeAll(
    NamespaceProvider(),
    NamespaceAuthorizationRuleProvider(),
    NotificationHubProvider(),
    NotificationHubAuthorizationRuleProvider(),
  );
