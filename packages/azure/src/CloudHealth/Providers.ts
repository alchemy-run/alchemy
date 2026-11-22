import * as Layer from "effect/Layer";
import { AuthenticationSetting, AuthenticationSettingProvider } from "./AuthenticationSetting.ts";
import { DiscoveryRule, DiscoveryRuleProvider } from "./DiscoveryRule.ts";
import { Entity, EntityProvider } from "./Entity.ts";
import { HealthModel, HealthModelProvider } from "./HealthModel.ts";
import { Relationship, RelationshipProvider } from "./Relationship.ts";
import { SignalDefinition, SignalDefinitionProvider } from "./SignalDefinition.ts";

export const resources = [
  AuthenticationSetting,
  DiscoveryRule,
  Entity,
  HealthModel,
  Relationship,
  SignalDefinition,
];
export const layers = () =>
  Layer.mergeAll(
    AuthenticationSettingProvider(),
    DiscoveryRuleProvider(),
    EntityProvider(),
    HealthModelProvider(),
    RelationshipProvider(),
    SignalDefinitionProvider(),
  );
