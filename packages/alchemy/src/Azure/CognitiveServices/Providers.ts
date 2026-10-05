import * as Layer from "effect/Layer";
import { Account, AccountProvider } from "./Account.ts";
import {
  AgentApplication,
  AgentApplicationProvider,
} from "./AgentApplication.ts";
import { AgentDeployment, AgentDeploymentProvider } from "./AgentDeployment.ts";
import { CapabilityHost, CapabilityHostProvider } from "./CapabilityHost.ts";
import { Connection, ConnectionProvider } from "./Connection.ts";
import {
  DefenderForAISetting,
  DefenderForAISettingProvider,
} from "./DefenderForAISetting.ts";
import { Deployment, DeploymentProvider } from "./Deployment.ts";
import { EncryptionScope, EncryptionScopeProvider } from "./EncryptionScope.ts";
import { ManagedNetwork, ManagedNetworkProvider } from "./ManagedNetwork.ts";
import { OutboundRule, OutboundRuleProvider } from "./OutboundRule.ts";
import { Project, ProjectProvider } from "./Project.ts";
import {
  ProjectCapabilityHost,
  ProjectCapabilityHostProvider,
} from "./ProjectCapabilityHost.ts";
import {
  ProjectConnection,
  ProjectConnectionProvider,
} from "./ProjectConnection.ts";
import { RaiBlocklist, RaiBlocklistProvider } from "./RaiBlocklist.ts";
import {
  RaiBlocklistItem,
  RaiBlocklistItemProvider,
} from "./RaiBlocklistItem.ts";
import {
  RaiExternalSafetyProvider,
  RaiExternalSafetyProviderProvider,
} from "./RaiExternalSafetyProvider.ts";
import { RaiPolicy, RaiPolicyProvider } from "./RaiPolicy.ts";
import { RaiToolLabel, RaiToolLabelProvider } from "./RaiToolLabel.ts";
import { RaiTopic, RaiTopicProvider } from "./RaiTopic.ts";
import {
  SubscriptionRaiPolicy,
  SubscriptionRaiPolicyProvider,
} from "./SubscriptionRaiPolicy.ts";

export const resources = [
  Account,
  AgentApplication,
  AgentDeployment,
  CapabilityHost,
  Connection,
  DefenderForAISetting,
  Deployment,
  EncryptionScope,
  ManagedNetwork,
  OutboundRule,
  Project,
  ProjectCapabilityHost,
  ProjectConnection,
  RaiBlocklist,
  RaiBlocklistItem,
  RaiExternalSafetyProvider,
  RaiPolicy,
  RaiToolLabel,
  RaiTopic,
  SubscriptionRaiPolicy,
];
export const layers = () =>
  Layer.mergeAll(
    AccountProvider(),
    AgentApplicationProvider(),
    AgentDeploymentProvider(),
    CapabilityHostProvider(),
    ConnectionProvider(),
    DefenderForAISettingProvider(),
    DeploymentProvider(),
    EncryptionScopeProvider(),
    ManagedNetworkProvider(),
    OutboundRuleProvider(),
    ProjectProvider(),
    ProjectCapabilityHostProvider(),
    ProjectConnectionProvider(),
    RaiBlocklistProvider(),
    RaiBlocklistItemProvider(),
    RaiExternalSafetyProviderProvider(),
    RaiPolicyProvider(),
    RaiToolLabelProvider(),
    RaiTopicProvider(),
    SubscriptionRaiPolicyProvider(),
  );
