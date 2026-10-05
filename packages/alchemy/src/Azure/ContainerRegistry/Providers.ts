import * as Layer from "effect/Layer";
import { CacheRule, CacheRuleProvider } from "./CacheRule.ts";
import {
  ConnectedRegistry,
  ConnectedRegistryProvider,
} from "./ConnectedRegistry.ts";
import { CredentialSet, CredentialSetProvider } from "./CredentialSet.ts";
import { Registry, RegistryProvider } from "./Registry.ts";
import { Replication, ReplicationProvider } from "./Replication.ts";
import { ScopeMap, ScopeMapProvider } from "./ScopeMap.ts";
import { Task, TaskProvider } from "./Task.ts";
import { Token, TokenProvider } from "./Token.ts";
import { Webhook, WebhookProvider } from "./Webhook.ts";

export const resources = [
  CacheRule,
  ConnectedRegistry,
  CredentialSet,
  Registry,
  Replication,
  ScopeMap,
  Task,
  Token,
  Webhook,
];
export const layers = () =>
  Layer.mergeAll(
    CacheRuleProvider(),
    ConnectedRegistryProvider(),
    CredentialSetProvider(),
    RegistryProvider(),
    ReplicationProvider(),
    ScopeMapProvider(),
    TaskProvider(),
    TokenProvider(),
    WebhookProvider(),
  );
