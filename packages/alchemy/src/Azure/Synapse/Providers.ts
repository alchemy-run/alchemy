import * as Layer from "effect/Layer";
import {
  AzureADOnlyAuthentication,
  AzureADOnlyAuthenticationProvider,
} from "./AzureADOnlyAuthentication.ts";
import { BigDataPool, BigDataPoolProvider } from "./BigDataPool.ts";
import {
  DedicatedSqlMinimalTlsSetting,
  DedicatedSqlMinimalTlsSettingProvider,
} from "./DedicatedSqlMinimalTlsSetting.ts";
import {
  EncryptionProtector,
  EncryptionProtectorProvider,
} from "./EncryptionProtector.ts";
import { FirewallRule, FirewallRuleProvider } from "./FirewallRule.ts";
import {
  IntegrationRuntime,
  IntegrationRuntimeProvider,
} from "./IntegrationRuntime.ts";
import {
  ManagedIdentitySqlControlSetting,
  ManagedIdentitySqlControlSettingProvider,
} from "./ManagedIdentitySqlControlSetting.ts";
import { PrivateLinkHub, PrivateLinkHubProvider } from "./PrivateLinkHub.ts";
import { SqlPool, SqlPoolProvider } from "./SqlPool.ts";
import {
  SqlPoolAuditingSetting,
  SqlPoolAuditingSettingProvider,
} from "./SqlPoolAuditingSetting.ts";
import {
  SqlPoolDataMaskingPolicy,
  SqlPoolDataMaskingPolicyProvider,
} from "./SqlPoolDataMaskingPolicy.ts";
import {
  SqlPoolDataMaskingRule,
  SqlPoolDataMaskingRuleProvider,
} from "./SqlPoolDataMaskingRule.ts";
import {
  SqlPoolExtendedAuditingSetting,
  SqlPoolExtendedAuditingSettingProvider,
} from "./SqlPoolExtendedAuditingSetting.ts";
import {
  SqlPoolGeoBackupPolicy,
  SqlPoolGeoBackupPolicyProvider,
} from "./SqlPoolGeoBackupPolicy.ts";
import {
  SqlPoolMaintenanceWindow,
  SqlPoolMaintenanceWindowProvider,
} from "./SqlPoolMaintenanceWindow.ts";
import {
  SqlPoolSecurityAlertPolicy,
  SqlPoolSecurityAlertPolicyProvider,
} from "./SqlPoolSecurityAlertPolicy.ts";
import {
  SqlPoolTransparentDataEncryption,
  SqlPoolTransparentDataEncryptionProvider,
} from "./SqlPoolTransparentDataEncryption.ts";
import {
  SqlPoolVulnerabilityAssessment,
  SqlPoolVulnerabilityAssessmentProvider,
} from "./SqlPoolVulnerabilityAssessment.ts";
import {
  WorkloadClassifier,
  WorkloadClassifierProvider,
} from "./WorkloadClassifier.ts";
import { WorkloadGroup, WorkloadGroupProvider } from "./WorkloadGroup.ts";
import { Workspace, WorkspaceProvider } from "./Workspace.ts";
import {
  WorkspaceAadAdmin,
  WorkspaceAadAdminProvider,
} from "./WorkspaceAadAdmin.ts";
import {
  WorkspaceAuditingSetting,
  WorkspaceAuditingSettingProvider,
} from "./WorkspaceAuditingSetting.ts";
import {
  WorkspaceExtendedAuditingSetting,
  WorkspaceExtendedAuditingSettingProvider,
} from "./WorkspaceExtendedAuditingSetting.ts";
import { WorkspaceKey, WorkspaceKeyProvider } from "./WorkspaceKey.ts";
import {
  WorkspaceSecurityAlertPolicy,
  WorkspaceSecurityAlertPolicyProvider,
} from "./WorkspaceSecurityAlertPolicy.ts";
import {
  WorkspaceVulnerabilityAssessment,
  WorkspaceVulnerabilityAssessmentProvider,
} from "./WorkspaceVulnerabilityAssessment.ts";

export const resources = [
  AzureADOnlyAuthentication,
  BigDataPool,
  DedicatedSqlMinimalTlsSetting,
  EncryptionProtector,
  FirewallRule,
  IntegrationRuntime,
  ManagedIdentitySqlControlSetting,
  PrivateLinkHub,
  SqlPool,
  SqlPoolAuditingSetting,
  SqlPoolDataMaskingPolicy,
  SqlPoolDataMaskingRule,
  SqlPoolExtendedAuditingSetting,
  SqlPoolGeoBackupPolicy,
  SqlPoolMaintenanceWindow,
  SqlPoolSecurityAlertPolicy,
  SqlPoolTransparentDataEncryption,
  SqlPoolVulnerabilityAssessment,
  WorkloadClassifier,
  WorkloadGroup,
  Workspace,
  WorkspaceAadAdmin,
  WorkspaceAuditingSetting,
  WorkspaceExtendedAuditingSetting,
  WorkspaceKey,
  WorkspaceSecurityAlertPolicy,
  WorkspaceVulnerabilityAssessment,
];
export const layers = () =>
  Layer.mergeAll(
    AzureADOnlyAuthenticationProvider(),
    BigDataPoolProvider(),
    DedicatedSqlMinimalTlsSettingProvider(),
    EncryptionProtectorProvider(),
    FirewallRuleProvider(),
    IntegrationRuntimeProvider(),
    ManagedIdentitySqlControlSettingProvider(),
    PrivateLinkHubProvider(),
    SqlPoolProvider(),
    SqlPoolAuditingSettingProvider(),
    SqlPoolDataMaskingPolicyProvider(),
    SqlPoolDataMaskingRuleProvider(),
    SqlPoolExtendedAuditingSettingProvider(),
    SqlPoolGeoBackupPolicyProvider(),
    SqlPoolMaintenanceWindowProvider(),
    SqlPoolSecurityAlertPolicyProvider(),
    SqlPoolTransparentDataEncryptionProvider(),
    SqlPoolVulnerabilityAssessmentProvider(),
    WorkloadClassifierProvider(),
    WorkloadGroupProvider(),
    WorkspaceProvider(),
    WorkspaceAadAdminProvider(),
    WorkspaceAuditingSettingProvider(),
    WorkspaceExtendedAuditingSettingProvider(),
    WorkspaceKeyProvider(),
    WorkspaceSecurityAlertPolicyProvider(),
    WorkspaceVulnerabilityAssessmentProvider(),
  );
