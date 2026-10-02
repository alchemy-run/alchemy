import * as Layer from "effect/Layer";
import {
  BackupShortTermRetentionPolicy,
  BackupShortTermRetentionPolicyProvider,
} from "./BackupShortTermRetentionPolicy.ts";
import { Database, DatabaseProvider } from "./Database.ts";
import { ElasticPool, ElasticPoolProvider } from "./ElasticPool.ts";
import { FailoverGroup, FailoverGroupProvider } from "./FailoverGroup.ts";
import { FirewallRule, FirewallRuleProvider } from "./FirewallRule.ts";
import {
  InstanceFailoverGroup,
  InstanceFailoverGroupProvider,
} from "./InstanceFailoverGroup.ts";
import { InstancePool, InstancePoolProvider } from "./InstancePool.ts";
import { JobAgent, JobAgentProvider } from "./JobAgent.ts";
import {
  LongTermRetentionPolicy,
  LongTermRetentionPolicyProvider,
} from "./LongTermRetentionPolicy.ts";
import { ManagedInstance, ManagedInstanceProvider } from "./ManagedInstance.ts";
import { Server, ServerProvider } from "./Server.ts";
import {
  ServerAzureADAdministrator,
  ServerAzureADAdministratorProvider,
} from "./ServerAzureADAdministrator.ts";
import {
  ServerAzureADOnlyAuthentication,
  ServerAzureADOnlyAuthenticationProvider,
} from "./ServerAzureADOnlyAuthentication.ts";
import {
  ServerBlobAuditingPolicy,
  ServerBlobAuditingPolicyProvider,
} from "./ServerBlobAuditingPolicy.ts";
import {
  ServerTrustGroup,
  ServerTrustGroupProvider,
} from "./ServerTrustGroup.ts";
import {
  VirtualNetworkRule,
  VirtualNetworkRuleProvider,
} from "./VirtualNetworkRule.ts";

export const resources = [
  BackupShortTermRetentionPolicy,
  Database,
  ElasticPool,
  FailoverGroup,
  FirewallRule,
  InstanceFailoverGroup,
  InstancePool,
  JobAgent,
  LongTermRetentionPolicy,
  ManagedInstance,
  Server,
  ServerAzureADAdministrator,
  ServerAzureADOnlyAuthentication,
  ServerBlobAuditingPolicy,
  ServerTrustGroup,
  VirtualNetworkRule,
];
export const layers = () =>
  Layer.mergeAll(
    BackupShortTermRetentionPolicyProvider(),
    DatabaseProvider(),
    ElasticPoolProvider(),
    FailoverGroupProvider(),
    FirewallRuleProvider(),
    InstanceFailoverGroupProvider(),
    InstancePoolProvider(),
    JobAgentProvider(),
    LongTermRetentionPolicyProvider(),
    ManagedInstanceProvider(),
    ServerProvider(),
    ServerAzureADAdministratorProvider(),
    ServerAzureADOnlyAuthenticationProvider(),
    ServerBlobAuditingPolicyProvider(),
    ServerTrustGroupProvider(),
    VirtualNetworkRuleProvider(),
  );
