import * as Layer from "effect/Layer";
import { Account, AccountProvider } from "./Account.ts";
import { CapabilityHost, CapabilityHostProvider } from "./CapabilityHost.ts";
import { Connection, ConnectionProvider } from "./Connection.ts";
import {
  DefenderForAISetting,
  DefenderForAISettingProvider,
} from "./DefenderForAISetting.ts";
import { Deployment, DeploymentProvider } from "./Deployment.ts";
import { EncryptionScope, EncryptionScopeProvider } from "./EncryptionScope.ts";
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
import { RaiPolicy, RaiPolicyProvider } from "./RaiPolicy.ts";
import { RaiToolLabel, RaiToolLabelProvider } from "./RaiToolLabel.ts";
import { RaiTopic, RaiTopicProvider } from "./RaiTopic.ts";
import {
  SubscriptionRaiPolicy,
  SubscriptionRaiPolicyProvider,
} from "./SubscriptionRaiPolicy.ts";

export const resources = [
  Account,
  CapabilityHost,
  Connection,
  DefenderForAISetting,
  Deployment,
  EncryptionScope,
  Project,
  ProjectCapabilityHost,
  ProjectConnection,
  RaiBlocklist,
  RaiBlocklistItem,
  RaiPolicy,
  RaiToolLabel,
  RaiTopic,
  SubscriptionRaiPolicy,
];
export const layers = () =>
  Layer.mergeAll(
    AccountProvider(),
    CapabilityHostProvider(),
    ConnectionProvider(),
    DefenderForAISettingProvider(),
    DeploymentProvider(),
    EncryptionScopeProvider(),
    ProjectProvider(),
    ProjectCapabilityHostProvider(),
    ProjectConnectionProvider(),
    RaiBlocklistProvider(),
    RaiBlocklistItemProvider(),
    RaiPolicyProvider(),
    RaiToolLabelProvider(),
    RaiTopicProvider(),
    SubscriptionRaiPolicyProvider(),
  );
