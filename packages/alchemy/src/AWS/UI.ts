import * as Layer from "effect/Layer";
import * as ACMUI from "./ACM/ui.ts";
import * as ACMPCAUI from "./ACMPCA/ui.ts";
import * as AIOpsUI from "./AIOps/ui.ts";
import * as AMPUI from "./AMP/ui.ts";
import * as AccessAnalyzerUI from "./AccessAnalyzer/ui.ts";
import * as AccountUI from "./Account/ui.ts";
import * as AmplifyUI from "./Amplify/ui.ts";
import * as ApiGatewayUI from "./ApiGateway/ui.ts";
import * as ApiGatewayV2UI from "./ApiGatewayV2/ui.ts";
import * as AppConfigUI from "./AppConfig/ui.ts";
import * as AppFlowUI from "./AppFlow/ui.ts";
import * as AppIntegrationsUI from "./AppIntegrations/ui.ts";
import * as AppRegistryUI from "./AppRegistry/ui.ts";
import * as AppRunnerUI from "./AppRunner/ui.ts";
import * as AppSyncUI from "./AppSync/ui.ts";
import * as ApplicationAutoScalingUI from "./ApplicationAutoScaling/ui.ts";
import * as ApplicationSignalsUI from "./ApplicationSignals/ui.ts";
import * as AthenaUI from "./Athena/ui.ts";
import * as AuditManagerUI from "./AuditManager/ui.ts";
import * as AutoScalingUI from "./AutoScaling/ui.ts";
import * as B2BIUI from "./B2BI/ui.ts";
import * as BCMDataExportsUI from "./BCMDataExports/ui.ts";
import * as BackupUI from "./Backup/ui.ts";
import * as BackupSearchUI from "./BackupSearch/ui.ts";
import * as BatchUI from "./Batch/ui.ts";
import * as BedrockUI from "./Bedrock/ui.ts";
import * as BedrockAgentCoreUI from "./BedrockAgentCore/ui.ts";
import * as BedrockDataAutomationUI from "./BedrockDataAutomation/ui.ts";
import * as BudgetsUI from "./Budgets/ui.ts";
import * as ChatbotUI from "./Chatbot/ui.ts";
import * as CloudFormationUI from "./CloudFormation/ui.ts";
import * as CloudFrontUI from "./CloudFront/ui.ts";
import * as CloudHSMV2UI from "./CloudHSMV2/ui.ts";
import * as CloudMapUI from "./CloudMap/ui.ts";
import * as CloudTrailUI from "./CloudTrail/ui.ts";
import * as CloudWatchUI from "./CloudWatch/ui.ts";
import * as CodeArtifactUI from "./CodeArtifact/ui.ts";
import * as CodeBuildUI from "./CodeBuild/ui.ts";
import * as CodeConnectionsUI from "./CodeConnections/ui.ts";
import * as CodeDeployUI from "./CodeDeploy/ui.ts";
import * as CodePipelineUI from "./CodePipeline/ui.ts";
import * as CognitoUI from "./Cognito/ui.ts";
import * as ConfigUI from "./Config/ui.ts";
import * as ControlTowerUI from "./ControlTower/ui.ts";
import * as CostAndUsageReportUI from "./CostAndUsageReport/ui.ts";
import * as CostExplorerUI from "./CostExplorer/ui.ts";
import * as DAXUI from "./DAX/ui.ts";
import * as DLMUI from "./DLM/ui.ts";
import * as DMSUI from "./DMS/ui.ts";
import * as DSQLUI from "./DSQL/ui.ts";
import * as DataBrewUI from "./DataBrew/ui.ts";
import * as DataExchangeUI from "./DataExchange/ui.ts";
import * as DataSyncUI from "./DataSync/ui.ts";
import * as DataZoneUI from "./DataZone/ui.ts";
import * as DeadlineUI from "./Deadline/ui.ts";
import * as DetectiveUI from "./Detective/ui.ts";
import * as DevOpsGuruUI from "./DevOpsGuru/ui.ts";
import * as DirectoryServiceUI from "./DirectoryService/ui.ts";
import * as DocDBUI from "./DocDB/ui.ts";
import * as DocDBElasticUI from "./DocDBElastic/ui.ts";
import * as DynamoDBUI from "./DynamoDB/ui.ts";
import * as EC2UI from "./EC2/ui.ts";
import * as ECRUI from "./ECR/ui.ts";
import * as ECRPublicUI from "./ECRPublic/ui.ts";
import * as ECSUI from "./ECS/ui.ts";
import * as EFSUI from "./EFS/ui.ts";
import * as EKSUI from "./EKS/ui.ts";
import * as ELBv2UI from "./ELBv2/ui.ts";
import * as EMRUI from "./EMR/ui.ts";
import * as EMRContainersUI from "./EMRContainers/ui.ts";
import * as EMRServerlessUI from "./EMRServerless/ui.ts";
import * as ElastiCacheUI from "./ElastiCache/ui.ts";
import * as EntityResolutionUI from "./EntityResolution/ui.ts";
import * as EventBridgeUI from "./EventBridge/ui.ts";
import * as FISUI from "./FIS/ui.ts";
import * as FMSUI from "./FMS/ui.ts";
import * as FSxUI from "./FSx/ui.ts";
import * as FinSpaceUI from "./FinSpace/ui.ts";
import * as FirehoseUI from "./Firehose/ui.ts";
import * as ForecastUI from "./Forecast/ui.ts";
import * as FraudDetectorUI from "./FraudDetector/ui.ts";
import * as GlacierUI from "./Glacier/ui.ts";
import * as GlobalAcceleratorUI from "./GlobalAccelerator/ui.ts";
import * as GlueUI from "./Glue/ui.ts";
import * as GrafanaUI from "./Grafana/ui.ts";
import * as GreengrassV2UI from "./GreengrassV2/ui.ts";
import * as GuardDutyUI from "./GuardDuty/ui.ts";
import * as HealthLakeUI from "./HealthLake/ui.ts";
import * as IAMUI from "./IAM/ui.ts";
import * as IVSUI from "./IVS/ui.ts";
import * as IVSChatUI from "./IVSChat/ui.ts";
import * as IVSRealtimeUI from "./IVSRealtime/ui.ts";
import * as IdentityCenterUI from "./IdentityCenter/ui.ts";
import * as ImageBuilderUI from "./ImageBuilder/ui.ts";
import * as Inspector2UI from "./Inspector2/ui.ts";
import * as InternetMonitorUI from "./InternetMonitor/ui.ts";
import * as IoTUI from "./IoT/ui.ts";
import * as IoTFleetWiseUI from "./IoTFleetWise/ui.ts";
import * as IoTManagedIntegrationsUI from "./IoTManagedIntegrations/ui.ts";
import * as IoTSiteWiseUI from "./IoTSiteWise/ui.ts";
import * as IoTWirelessUI from "./IoTWireless/ui.ts";
import * as KMSUI from "./KMS/ui.ts";
import * as KafkaUI from "./Kafka/ui.ts";
import * as KendraUI from "./Kendra/ui.ts";
import * as KeyspacesUI from "./Keyspaces/ui.ts";
import * as KinesisUI from "./Kinesis/ui.ts";
import * as KinesisAnalyticsV2UI from "./KinesisAnalyticsV2/ui.ts";
import * as KinesisVideoUI from "./KinesisVideo/ui.ts";
import * as LakeFormationUI from "./LakeFormation/ui.ts";
import * as LambdaUI from "./Lambda/ui.ts";
import * as LexV2UI from "./LexV2/ui.ts";
import * as LicenseManagerUI from "./LicenseManager/ui.ts";
import * as LocationUI from "./Location/ui.ts";
import * as LogsUI from "./Logs/ui.ts";
import * as MQUI from "./MQ/ui.ts";
import * as MWAAUI from "./MWAA/ui.ts";
import * as MWAAServerlessUI from "./MWAAServerless/ui.ts";
import * as Macie2UI from "./Macie2/ui.ts";
import * as MailManagerUI from "./MailManager/ui.ts";
import * as MediaConnectUI from "./MediaConnect/ui.ts";
import * as MediaConvertUI from "./MediaConvert/ui.ts";
import * as MediaLiveUI from "./MediaLive/ui.ts";
import * as MediaPackageV2UI from "./MediaPackageV2/ui.ts";
import * as MediaTailorUI from "./MediaTailor/ui.ts";
import * as MedicalImagingUI from "./MedicalImaging/ui.ts";
import * as MemoryDBUI from "./MemoryDB/ui.ts";
import * as NeptuneUI from "./Neptune/ui.ts";
import * as NeptuneGraphUI from "./NeptuneGraph/ui.ts";
import * as NetworkFirewallUI from "./NetworkFirewall/ui.ts";
import * as NotificationsUI from "./Notifications/ui.ts";
import * as NotificationsContactsUI from "./NotificationsContacts/ui.ts";
import * as OAMUI from "./OAM/ui.ts";
import * as OSISUI from "./OSIS/ui.ts";
import * as ObservabilityAdminUI from "./ObservabilityAdmin/ui.ts";
import * as OmicsUI from "./Omics/ui.ts";
import * as OpenSearchUI from "./OpenSearch/ui.ts";
import * as OpenSearchServerlessUI from "./OpenSearchServerless/ui.ts";
import * as OrganizationsUI from "./Organizations/ui.ts";
import * as PaymentCryptographyUI from "./PaymentCryptography/ui.ts";
import * as PersonalizeUI from "./Personalize/ui.ts";
import * as PinpointSMSVoiceV2UI from "./PinpointSMSVoiceV2/ui.ts";
import * as PipesUI from "./Pipes/ui.ts";
import * as PollyUI from "./Polly/ui.ts";
import * as QAppsUI from "./QApps/ui.ts";
import * as QBusinessUI from "./QBusiness/ui.ts";
import * as QuickSightUI from "./QuickSight/ui.ts";
import * as RAMUI from "./RAM/ui.ts";
import * as RDSUI from "./RDS/ui.ts";
import * as RUMUI from "./RUM/ui.ts";
import * as RbinUI from "./Rbin/ui.ts";
import * as RePostSpaceUI from "./RePostSpace/ui.ts";
import * as RedshiftUI from "./Redshift/ui.ts";
import * as RedshiftServerlessUI from "./RedshiftServerless/ui.ts";
import * as ResourceExplorerUI from "./ResourceExplorer/ui.ts";
import * as ResourceGroupsUI from "./ResourceGroups/ui.ts";
import * as RolesAnywhereUI from "./RolesAnywhere/ui.ts";
import * as Route53UI from "./Route53/ui.ts";
import * as Route53ProfilesUI from "./Route53Profiles/ui.ts";
import * as Route53ResolverUI from "./Route53Resolver/ui.ts";
import * as S3UI from "./S3/ui.ts";
import * as S3ControlUI from "./S3Control/ui.ts";
import * as S3FilesUI from "./S3Files/ui.ts";
import * as S3TablesUI from "./S3Tables/ui.ts";
import * as S3VectorsUI from "./S3Vectors/ui.ts";
import * as SESUI from "./SES/ui.ts";
import * as SNSUI from "./SNS/ui.ts";
import * as SQSUI from "./SQS/ui.ts";
import * as SSMUI from "./SSM/ui.ts";
import * as SSMContactsUI from "./SSMContacts/ui.ts";
import * as SSMIncidentsUI from "./SSMIncidents/ui.ts";
import * as SageMakerUI from "./SageMaker/ui.ts";
import * as SchedulerUI from "./Scheduler/ui.ts";
import * as SchemasUI from "./Schemas/ui.ts";
import * as SecretsManagerUI from "./SecretsManager/ui.ts";
import * as SecurityHubUI from "./SecurityHub/ui.ts";
import * as SecurityLakeUI from "./SecurityLake/ui.ts";
import * as ServiceCatalogUI from "./ServiceCatalog/ui.ts";
import * as ServiceQuotasUI from "./ServiceQuotas/ui.ts";
import * as ShieldUI from "./Shield/ui.ts";
import * as SignerUI from "./Signer/ui.ts";
import * as SimpleDBUI from "./SimpleDB/ui.ts";
import * as SocialMessagingUI from "./SocialMessaging/ui.ts";
import * as StepFunctionsUI from "./StepFunctions/ui.ts";
import * as SyntheticsUI from "./Synthetics/ui.ts";
import * as TextractUI from "./Textract/ui.ts";
import * as TimestreamUI from "./Timestream/ui.ts";
import * as TransferUI from "./Transfer/ui.ts";
import * as TranslateUI from "./Translate/ui.ts";
import * as VerifiedPermissionsUI from "./VerifiedPermissions/ui.ts";
import * as VpcLatticeUI from "./VpcLattice/ui.ts";
import * as WAFv2UI from "./WAFv2/ui.ts";
import * as WebsiteUI from "./Website/ui.ts";
import * as XRayUI from "./XRay/ui.ts";

/**
 * Aggregated dashboard UI providers for every AWS service.
 *
 * Generated by scripts (see processes/Dashboard.md). Per-service providers
 * live in `AWS/{Service}/ui.ts`; keep merge groups nested (≤ 35
 * entries) to stay under tsc's variadic-inference ceiling.
 */
export const ui = () =>
  Layer.mergeAll(
    Layer.mergeAll(
      ACMUI.ui(),
      ACMPCAUI.ui(),
      AIOpsUI.ui(),
      AMPUI.ui(),
      AccessAnalyzerUI.ui(),
      AccountUI.ui(),
      AmplifyUI.ui(),
      ApiGatewayUI.ui(),
      ApiGatewayV2UI.ui(),
      AppConfigUI.ui(),
      AppFlowUI.ui(),
      AppIntegrationsUI.ui(),
      AppRegistryUI.ui(),
      AppRunnerUI.ui(),
      AppSyncUI.ui(),
      ApplicationAutoScalingUI.ui(),
      ApplicationSignalsUI.ui(),
      AthenaUI.ui(),
      AuditManagerUI.ui(),
      AutoScalingUI.ui(),
      B2BIUI.ui(),
      BCMDataExportsUI.ui(),
      BackupUI.ui(),
      BackupSearchUI.ui(),
      BatchUI.ui(),
      BedrockUI.ui(),
      BedrockAgentCoreUI.ui(),
      BedrockDataAutomationUI.ui(),
      BudgetsUI.ui(),
      ChatbotUI.ui(),
      CloudFormationUI.ui(),
      CloudFrontUI.ui(),
      CloudHSMV2UI.ui(),
      CloudMapUI.ui(),
      CloudTrailUI.ui(),
    ),
    Layer.mergeAll(
      CloudWatchUI.ui(),
      CodeArtifactUI.ui(),
      CodeBuildUI.ui(),
      CodeConnectionsUI.ui(),
      CodeDeployUI.ui(),
      CodePipelineUI.ui(),
      CognitoUI.ui(),
      ConfigUI.ui(),
      ControlTowerUI.ui(),
      CostAndUsageReportUI.ui(),
      CostExplorerUI.ui(),
      DAXUI.ui(),
      DLMUI.ui(),
      DMSUI.ui(),
      DSQLUI.ui(),
      DataBrewUI.ui(),
      DataExchangeUI.ui(),
      DataSyncUI.ui(),
      DataZoneUI.ui(),
      DeadlineUI.ui(),
      DetectiveUI.ui(),
      DevOpsGuruUI.ui(),
      DirectoryServiceUI.ui(),
      DocDBUI.ui(),
      DocDBElasticUI.ui(),
      DynamoDBUI.ui(),
      EC2UI.ui(),
      ECRUI.ui(),
      ECRPublicUI.ui(),
      ECSUI.ui(),
      EFSUI.ui(),
      EKSUI.ui(),
      ELBv2UI.ui(),
      EMRUI.ui(),
      EMRContainersUI.ui(),
    ),
    Layer.mergeAll(
      EMRServerlessUI.ui(),
      ElastiCacheUI.ui(),
      EntityResolutionUI.ui(),
      EventBridgeUI.ui(),
      FISUI.ui(),
      FMSUI.ui(),
      FSxUI.ui(),
      FinSpaceUI.ui(),
      FirehoseUI.ui(),
      ForecastUI.ui(),
      FraudDetectorUI.ui(),
      GlacierUI.ui(),
      GlobalAcceleratorUI.ui(),
      GlueUI.ui(),
      GrafanaUI.ui(),
      GreengrassV2UI.ui(),
      GuardDutyUI.ui(),
      HealthLakeUI.ui(),
      IAMUI.ui(),
      IVSUI.ui(),
      IVSChatUI.ui(),
      IVSRealtimeUI.ui(),
      IdentityCenterUI.ui(),
      ImageBuilderUI.ui(),
      Inspector2UI.ui(),
      InternetMonitorUI.ui(),
      IoTUI.ui(),
      IoTFleetWiseUI.ui(),
      IoTManagedIntegrationsUI.ui(),
      IoTSiteWiseUI.ui(),
      IoTWirelessUI.ui(),
      KMSUI.ui(),
      KafkaUI.ui(),
      KendraUI.ui(),
      KeyspacesUI.ui(),
    ),
    Layer.mergeAll(
      KinesisUI.ui(),
      KinesisAnalyticsV2UI.ui(),
      KinesisVideoUI.ui(),
      LakeFormationUI.ui(),
      LambdaUI.ui(),
      LexV2UI.ui(),
      LicenseManagerUI.ui(),
      LocationUI.ui(),
      LogsUI.ui(),
      MQUI.ui(),
      MWAAUI.ui(),
      MWAAServerlessUI.ui(),
      Macie2UI.ui(),
      MailManagerUI.ui(),
      MediaConnectUI.ui(),
      MediaConvertUI.ui(),
      MediaLiveUI.ui(),
      MediaPackageV2UI.ui(),
      MediaTailorUI.ui(),
      MedicalImagingUI.ui(),
      MemoryDBUI.ui(),
      NeptuneUI.ui(),
      NeptuneGraphUI.ui(),
      NetworkFirewallUI.ui(),
      NotificationsUI.ui(),
      NotificationsContactsUI.ui(),
      OAMUI.ui(),
      OSISUI.ui(),
      ObservabilityAdminUI.ui(),
      OmicsUI.ui(),
      OpenSearchUI.ui(),
      OpenSearchServerlessUI.ui(),
      OrganizationsUI.ui(),
      PaymentCryptographyUI.ui(),
      PersonalizeUI.ui(),
    ),
    Layer.mergeAll(
      PinpointSMSVoiceV2UI.ui(),
      PipesUI.ui(),
      PollyUI.ui(),
      QAppsUI.ui(),
      QBusinessUI.ui(),
      QuickSightUI.ui(),
      RAMUI.ui(),
      RDSUI.ui(),
      RUMUI.ui(),
      RbinUI.ui(),
      RePostSpaceUI.ui(),
      RedshiftUI.ui(),
      RedshiftServerlessUI.ui(),
      ResourceExplorerUI.ui(),
      ResourceGroupsUI.ui(),
      RolesAnywhereUI.ui(),
      Route53UI.ui(),
      Route53ProfilesUI.ui(),
      Route53ResolverUI.ui(),
      S3UI.ui(),
      S3ControlUI.ui(),
      S3FilesUI.ui(),
      S3TablesUI.ui(),
      S3VectorsUI.ui(),
      SESUI.ui(),
      SNSUI.ui(),
      SQSUI.ui(),
      SSMUI.ui(),
      SSMContactsUI.ui(),
      SSMIncidentsUI.ui(),
      SageMakerUI.ui(),
      SchedulerUI.ui(),
      SchemasUI.ui(),
      SecretsManagerUI.ui(),
      SecurityHubUI.ui(),
    ),
    Layer.mergeAll(
      SecurityLakeUI.ui(),
      ServiceCatalogUI.ui(),
      ServiceQuotasUI.ui(),
      ShieldUI.ui(),
      SignerUI.ui(),
      SimpleDBUI.ui(),
      SocialMessagingUI.ui(),
      StepFunctionsUI.ui(),
      SyntheticsUI.ui(),
      TextractUI.ui(),
      TimestreamUI.ui(),
      TransferUI.ui(),
      TranslateUI.ui(),
      VerifiedPermissionsUI.ui(),
      VpcLatticeUI.ui(),
      WAFv2UI.ui(),
      WebsiteUI.ui(),
      XRayUI.ui(),
    ),
  );
