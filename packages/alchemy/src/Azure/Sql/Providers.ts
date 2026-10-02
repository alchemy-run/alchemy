import * as Layer from "effect/Layer";
import {
  BackupShortTermRetentionPolicy,
  BackupShortTermRetentionPolicyProvider,
} from "./BackupShortTermRetentionPolicy.ts";
import { Database, DatabaseProvider } from "./Database.ts";
import {
  DatabaseAdvancedThreatProtectionSettings,
  DatabaseAdvancedThreatProtectionSettingsProvider,
} from "./DatabaseAdvancedThreatProtectionSettings.ts";
import {
  DatabaseBlobAuditingPolicy,
  DatabaseBlobAuditingPolicyProvider,
} from "./DatabaseBlobAuditingPolicy.ts";
import {
  DatabaseSecurityAlertPolicy,
  DatabaseSecurityAlertPolicyProvider,
} from "./DatabaseSecurityAlertPolicy.ts";
import {
  DatabaseVulnerabilityAssessment,
  DatabaseVulnerabilityAssessmentProvider,
} from "./DatabaseVulnerabilityAssessment.ts";
import {
  DataMaskingPolicy,
  DataMaskingPolicyProvider,
} from "./DataMaskingPolicy.ts";
import { DataMaskingRule, DataMaskingRuleProvider } from "./DataMaskingRule.ts";
import { ElasticPool, ElasticPoolProvider } from "./ElasticPool.ts";
import {
  EncryptionProtector,
  EncryptionProtectorProvider,
} from "./EncryptionProtector.ts";
import {
  ExtendedDatabaseBlobAuditingPolicy,
  ExtendedDatabaseBlobAuditingPolicyProvider,
} from "./ExtendedDatabaseBlobAuditingPolicy.ts";
import {
  ExtendedServerBlobAuditingPolicy,
  ExtendedServerBlobAuditingPolicyProvider,
} from "./ExtendedServerBlobAuditingPolicy.ts";
import { FailoverGroup, FailoverGroupProvider } from "./FailoverGroup.ts";
import { FirewallRule, FirewallRuleProvider } from "./FirewallRule.ts";
import { GeoBackupPolicy, GeoBackupPolicyProvider } from "./GeoBackupPolicy.ts";
import {
  InstanceFailoverGroup,
  InstanceFailoverGroupProvider,
} from "./InstanceFailoverGroup.ts";
import { InstancePool, InstancePoolProvider } from "./InstancePool.ts";
import {
  IPv6FirewallRule,
  IPv6FirewallRuleProvider,
} from "./IPv6FirewallRule.ts";
import { JobAgent, JobAgentProvider } from "./JobAgent.ts";
import {
  LedgerDigestUpload,
  LedgerDigestUploadProvider,
} from "./LedgerDigestUpload.ts";
import {
  LongTermRetentionPolicy,
  LongTermRetentionPolicyProvider,
} from "./LongTermRetentionPolicy.ts";
import {
  MaintenanceWindow,
  MaintenanceWindowProvider,
} from "./MaintenanceWindow.ts";
import { ManagedInstance, ManagedInstanceProvider } from "./ManagedInstance.ts";
import {
  OutboundFirewallRule,
  OutboundFirewallRuleProvider,
} from "./OutboundFirewallRule.ts";
import {
  PrivateEndpointConnection,
  PrivateEndpointConnectionProvider,
} from "./PrivateEndpointConnection.ts";
import { Server, ServerProvider } from "./Server.ts";
import {
  ServerAdvancedThreatProtectionSettings,
  ServerAdvancedThreatProtectionSettingsProvider,
} from "./ServerAdvancedThreatProtectionSettings.ts";
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
  ServerConnectionPolicy,
  ServerConnectionPolicyProvider,
} from "./ServerConnectionPolicy.ts";
import {
  ServerDevOpsAuditSettings,
  ServerDevOpsAuditSettingsProvider,
} from "./ServerDevOpsAuditSettings.ts";
import { ServerDnsAlias, ServerDnsAliasProvider } from "./ServerDnsAlias.ts";
import { ServerKey, ServerKeyProvider } from "./ServerKey.ts";
import {
  ServerSecurityAlertPolicy,
  ServerSecurityAlertPolicyProvider,
} from "./ServerSecurityAlertPolicy.ts";
import {
  ServerTrustGroup,
  ServerTrustGroupProvider,
} from "./ServerTrustGroup.ts";
import {
  ServerVulnerabilityAssessment,
  ServerVulnerabilityAssessmentProvider,
} from "./ServerVulnerabilityAssessment.ts";
import {
  SqlVulnerabilityAssessmentSettings,
  SqlVulnerabilityAssessmentSettingsProvider,
} from "./SqlVulnerabilityAssessmentSettings.ts";
import {
  TransparentDataEncryption,
  TransparentDataEncryptionProvider,
} from "./TransparentDataEncryption.ts";
import {
  VirtualNetworkRule,
  VirtualNetworkRuleProvider,
} from "./VirtualNetworkRule.ts";

export const resources = [
  BackupShortTermRetentionPolicy,
  Database,
  DatabaseAdvancedThreatProtectionSettings,
  DatabaseBlobAuditingPolicy,
  DatabaseSecurityAlertPolicy,
  DatabaseVulnerabilityAssessment,
  DataMaskingPolicy,
  DataMaskingRule,
  ElasticPool,
  EncryptionProtector,
  ExtendedDatabaseBlobAuditingPolicy,
  ExtendedServerBlobAuditingPolicy,
  FailoverGroup,
  FirewallRule,
  GeoBackupPolicy,
  InstanceFailoverGroup,
  InstancePool,
  IPv6FirewallRule,
  JobAgent,
  LedgerDigestUpload,
  LongTermRetentionPolicy,
  MaintenanceWindow,
  ManagedInstance,
  OutboundFirewallRule,
  PrivateEndpointConnection,
  Server,
  ServerAdvancedThreatProtectionSettings,
  ServerAzureADAdministrator,
  ServerAzureADOnlyAuthentication,
  ServerBlobAuditingPolicy,
  ServerConnectionPolicy,
  ServerDevOpsAuditSettings,
  ServerDnsAlias,
  ServerKey,
  ServerSecurityAlertPolicy,
  ServerTrustGroup,
  ServerVulnerabilityAssessment,
  SqlVulnerabilityAssessmentSettings,
  TransparentDataEncryption,
  VirtualNetworkRule,
];

export const layers = () =>
  Layer.mergeAll(
    Layer.mergeAll(
      BackupShortTermRetentionPolicyProvider(),
      DatabaseProvider(),
      DatabaseAdvancedThreatProtectionSettingsProvider(),
      DatabaseBlobAuditingPolicyProvider(),
      DatabaseSecurityAlertPolicyProvider(),
      DatabaseVulnerabilityAssessmentProvider(),
      DataMaskingPolicyProvider(),
      DataMaskingRuleProvider(),
      ElasticPoolProvider(),
      EncryptionProtectorProvider(),
      ExtendedDatabaseBlobAuditingPolicyProvider(),
      ExtendedServerBlobAuditingPolicyProvider(),
      FailoverGroupProvider(),
      FirewallRuleProvider(),
      GeoBackupPolicyProvider(),
      InstanceFailoverGroupProvider(),
      InstancePoolProvider(),
      IPv6FirewallRuleProvider(),
      JobAgentProvider(),
      LedgerDigestUploadProvider(),
      LongTermRetentionPolicyProvider(),
      MaintenanceWindowProvider(),
      ManagedInstanceProvider(),
      OutboundFirewallRuleProvider(),
      PrivateEndpointConnectionProvider(),
      ServerProvider(),
      ServerAdvancedThreatProtectionSettingsProvider(),
      ServerAzureADAdministratorProvider(),
      ServerAzureADOnlyAuthenticationProvider(),
      ServerBlobAuditingPolicyProvider(),
      ServerConnectionPolicyProvider(),
      ServerDevOpsAuditSettingsProvider(),
      ServerDnsAliasProvider(),
      ServerKeyProvider(),
      ServerSecurityAlertPolicyProvider(),
      ServerTrustGroupProvider(),
      ServerVulnerabilityAssessmentProvider(),
      SqlVulnerabilityAssessmentSettingsProvider(),
      TransparentDataEncryptionProvider(),
      VirtualNetworkRuleProvider(),
    ),
  );
