import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as Layer from "effect/Layer";
import { CommandProvider } from "../Build/Command.ts";
import type { Provider } from "../Provider.ts";
import { RandomProvider } from "../Random.ts";
import * as Account from "./Account.ts";
import * as ACM from "./ACM/index.ts";
import * as Assets from "./Assets.ts";
import * as AutoScaling from "./AutoScaling/index.ts";
import * as CloudFront from "./CloudFront/index.ts";
import * as CloudWatch from "./CloudWatch/index.ts";
import * as Credentials from "./Credentials.ts";
import * as DynamoDB from "./DynamoDB/index.ts";
import * as EC2 from "./EC2/index.ts";
import * as ECR from "./ECR/index.ts";
import * as ECS from "./ECS/index.ts";
import * as EKS from "./EKS/index.ts";
import * as ELBv2 from "./ELBv2/index.ts";
import * as Endpoint from "./Endpoint.ts";
import * as EventBridge from "./EventBridge/index.ts";
import * as IAM from "./IAM/index.ts";
import * as IdentityCenter from "./IdentityCenter/index.ts";
import * as Kinesis from "./Kinesis/index.ts";
import * as Lambda from "./Lambda/index.ts";
import * as Logs from "./Logs/index.ts";
import * as Organizations from "./Organizations/index.ts";
import * as RDS from "./RDS/index.ts";
import * as RDSData from "./RDSData/index.ts";
import * as Region from "./Region.ts";
import * as Route53 from "./Route53/index.ts";
import * as S3 from "./S3/index.ts";
import * as Scheduler from "./Scheduler/index.ts";
import * as SecretsManager from "./SecretsManager/index.ts";
import * as SNS from "./SNS/index.ts";
import * as SQS from "./SQS/index.ts";
import { loadDefaultStageConfig, StageConfig } from "./StageConfig.ts";
import * as Website from "./Website/index.ts";

export type Providers = Extract<
  Layer.Success<ReturnType<typeof providers>>,
  Provider<any>
>;

/**
 * AWS providers with optional Assets layer for S3-based code deployment.
 * If the assets bucket exists (created via `alchemy-effect bootstrap`),
 * Lambda functions will use S3 for code deployment instead of inline ZipFile.
 */
export const providers = () =>
  pipe(
    resources(),
    Layer.provideMerge(bindings()),
    Layer.provideMerge(Assets.AssetsProvider()),
    Layer.provideMerge(Account.fromStageConfig()),
    Layer.provideMerge(Region.fromStageConfig()),
    Layer.provideMerge(Credentials.fromStageConfig()),
    Layer.provideMerge(Endpoint.fromStageConfig()),
    Layer.provideMerge(stageConfig()),
    Layer.orDie,
  );

export const stageConfig = () =>
  Layer.effect(StageConfig, Effect.suspend(loadDefaultStageConfig));

/**
 * Minimal AWS credential and account context without registering any resource
 * providers.
 */
export const credentials = () =>
  pipe(
    Account.fromStageConfig(),
    Layer.provideMerge(Region.fromStageConfig()),
    Layer.provideMerge(Credentials.fromStageConfig()),
    Layer.provideMerge(Endpoint.fromStageConfig()),
    Layer.provideMerge(stageConfig()),
  );

/**
 * All AWS resource providers.
 *
 * This layer registers the lifecycle providers that can create, read, update,
 * and delete AWS resources during plan and deploy.
 */
export const resources = () =>
  Layer.mergeAll(
    buildProviders(),
    acmProviders(),
    autoScalingProviders(),
    cloudFrontProviders(),
    cloudWatchProviders(),
    dynamoDbProviders(),
    ec2Providers(),
    ecrProviders(),
    ecsProviders(),
    eksProviders(),
    elbv2Providers(),
    eventBridgeProviders(),
    iamProviders(),
    identityCenterProviders(),
    kinesisProviders(),
    lambdaProviders(),
    logsProviders(),
    organizationsProviders(),
    rdsProviders(),
    route53Providers(),
    s3Providers(),
    schedulerProviders(),
    secretsManagerProviders(),
    snsProviders(),
    sqsProviders(),
    websiteProviders(),
  );

export const buildProviders = () =>
  Layer.mergeAll(CommandProvider(), RandomProvider());

export const acmProviders = () => Layer.mergeAll(ACM.CertificateProvider());

export const autoScalingProviders = () =>
  Layer.mergeAll(
    AutoScaling.AutoScalingGroupProvider(),
    AutoScaling.LaunchTemplateProvider(),
    AutoScaling.ScalingPolicyProvider(),
  );

export const cloudFrontProviders = () =>
  Layer.mergeAll(
    CloudFront.DistributionProvider(),
    CloudFront.FunctionProvider(),
    CloudFront.InvalidationProvider(),
    CloudFront.KeyValueStoreProvider(),
    CloudFront.KvEntriesProvider(),
    CloudFront.KvRoutesUpdateProvider(),
    CloudFront.OriginAccessControlProvider(),
  );

export const cloudWatchProviders = () =>
  Layer.mergeAll(
    CloudWatch.AlarmMuteRuleProvider(),
    CloudWatch.AlarmProvider(),
    CloudWatch.AnomalyDetectorProvider(),
    CloudWatch.CompositeAlarmProvider(),
    CloudWatch.DashboardProvider(),
    CloudWatch.InsightRuleProvider(),
    CloudWatch.MetricStreamProvider(),
  );

export const dynamoDbProviders = () => Layer.mergeAll(DynamoDB.TableProvider());

export const ec2Providers = () =>
  Layer.mergeAll(
    EC2.EgressOnlyInternetGatewayProvider(),
    EC2.EIPProvider(),
    EC2.InstanceProvider(),
    EC2.InternetGatewayProvider(),
    EC2.NatGatewayProvider(),
    EC2.NetworkAclAssociationProvider(),
    EC2.NetworkAclEntryProvider(),
    EC2.NetworkAclProvider(),
    EC2.RouteProvider(),
    EC2.RouteTableAssociationProvider(),
    EC2.RouteTableProvider(),
    EC2.SecurityGroupProvider(),
    EC2.SecurityGroupRuleProvider(),
    EC2.SubnetProvider(),
    EC2.VpcEndpointProvider(),
    EC2.VpcProvider(),
  );

export const ecrProviders = () => Layer.mergeAll(ECR.RepositoryProvider());

export const ecsProviders = () =>
  Layer.mergeAll(
    ECS.ClusterProvider(),
    ECS.ServiceProvider(),
    ECS.TaskProvider(),
  );

export const eksProviders = () =>
  Layer.mergeAll(
    EKS.AccessEntryProvider(),
    EKS.AddonProvider(),
    EKS.ClusterProvider(),
    EKS.PodIdentityAssociationProvider(),
  );

export const elbv2Providers = () =>
  Layer.mergeAll(
    ELBv2.ListenerProvider(),
    ELBv2.LoadBalancerProvider(),
    ELBv2.TargetGroupProvider(),
  );

export const eventBridgeProviders = () =>
  Layer.mergeAll(
    EventBridge.EventBusProvider(),
    EventBridge.PermissionProvider(),
    EventBridge.RuleProvider(),
  );

export const iamProviders = () =>
  Layer.mergeAll(
    IAM.AccessKeyProvider(),
    IAM.AccountAliasProvider(),
    IAM.AccountPasswordPolicyProvider(),
    IAM.GroupMembershipProvider(),
    IAM.GroupProvider(),
    IAM.InstanceProfileProvider(),
    IAM.LoginProfileProvider(),
    IAM.OpenIDConnectProviderProvider(),
    IAM.PolicyProvider(),
    IAM.RoleProvider(),
    IAM.SAMLProviderProvider(),
    IAM.ServerCertificateProvider(),
    IAM.ServiceSpecificCredentialProvider(),
    IAM.SigningCertificateProvider(),
    IAM.SSHPublicKeyProvider(),
    IAM.UserProvider(),
    IAM.VirtualMFADeviceProvider(),
  );

export const identityCenterProviders = () =>
  Layer.mergeAll(
    IdentityCenter.AccountAssignmentProvider(),
    IdentityCenter.GroupProvider(),
    IdentityCenter.InstanceProvider(),
    IdentityCenter.PermissionSetProvider(),
  );

export const kinesisProviders = () =>
  Layer.mergeAll(Kinesis.StreamConsumerProvider(), Kinesis.StreamProvider());

export const lambdaProviders = () =>
  Layer.mergeAll(
    Lambda.EventSourceMappingProvider(),
    Lambda.FunctionProvider(),
    Lambda.PermissionProvider(),
  );

export const logsProviders = () => Layer.mergeAll(Logs.LogGroupProvider());

export const organizationsProviders = () =>
  Layer.mergeAll(
    Organizations.AccountProvider(),
    Organizations.DelegatedAdministratorProvider(),
    Organizations.OrganizationalUnitProvider(),
    Organizations.OrganizationProvider(),
    Organizations.OrganizationResourcePolicyProvider(),
    Organizations.PolicyAttachmentProvider(),
    Organizations.PolicyProvider(),
    Organizations.RootPolicyTypeProvider(),
    Organizations.RootProvider(),
    Organizations.TrustedServiceAccessProvider(),
  );

export const rdsProviders = () =>
  Layer.mergeAll(
    RDS.DBClusterEndpointProvider(),
    RDS.DBClusterParameterGroupProvider(),
    RDS.DBClusterProvider(),
    RDS.DBInstanceProvider(),
    RDS.DBParameterGroupProvider(),
    RDS.DBProxyEndpointProvider(),
    RDS.DBProxyProvider(),
    RDS.DBProxyTargetGroupProvider(),
    RDS.DBSubnetGroupProvider(),
  );

export const route53Providers = () => Layer.mergeAll(Route53.RecordProvider());

export const s3Providers = () => Layer.mergeAll(S3.BucketProvider());

export const schedulerProviders = () =>
  Layer.mergeAll(
    Scheduler.ScheduleGroupProvider(),
    Scheduler.ScheduleProvider(),
  );

export const secretsManagerProviders = () =>
  Layer.mergeAll(SecretsManager.SecretProvider());

export const snsProviders = () =>
  Layer.mergeAll(SNS.SubscriptionProvider(), SNS.TopicProvider());

export const sqsProviders = () => Layer.mergeAll(SQS.QueueProvider());

export const websiteProviders = () =>
  Layer.mergeAll(Website.AssetDeploymentProvider());

/**
 * All AWS binding policies.
 *
 * These layers attach IAM statements and event-source bindings to functions at
 * deploy time so runtime bindings like `PutObject.bind(bucket)` can execute
 * with the required permissions.
 */
export const bindings = () =>
  Layer.mergeAll(
    cloudWatchBindings(),
    dynamoDbBindings(),
    ecsBindings(),
    eventBridgeBindings(),
    kinesisBindings(),
    lambdaBindings(),
    rdsBindings(),
    rdsDataBindings(),
    s3Bindings(),
    secretsManagerBindings(),
    snsBindings(),
    sqsBindings(),
  );

export const cloudWatchBindings = () =>
  Layer.mergeAll(
    CloudWatch.DescribeAlarmContributorsPolicyLive,
    CloudWatch.DescribeAlarmHistoryPolicyLive,
    CloudWatch.DescribeAlarmsForMetricPolicyLive,
    CloudWatch.DescribeAlarmsPolicyLive,
    CloudWatch.DescribeAnomalyDetectorsPolicyLive,
    CloudWatch.DescribeInsightRulesPolicyLive,
    CloudWatch.DisableAlarmActionsPolicyLive,
    CloudWatch.DisableInsightRulesPolicyLive,
    CloudWatch.EnableAlarmActionsPolicyLive,
    CloudWatch.GetAlarmMuteRulePolicyLive,
    CloudWatch.GetDashboardPolicyLive,
    CloudWatch.GetInsightRuleReportPolicyLive,
    CloudWatch.GetMetricDataPolicyLive,
    CloudWatch.GetMetricStatisticsPolicyLive,
    CloudWatch.GetMetricStreamPolicyLive,
    CloudWatch.GetMetricWidgetImagePolicyLive,
    CloudWatch.ListAlarmMuteRulesPolicyLive,
    CloudWatch.ListDashboardsPolicyLive,
    CloudWatch.ListManagedInsightRulesPolicyLive,
    CloudWatch.ListMetricsPolicyLive,
    CloudWatch.ListMetricStreamsPolicyLive,
    CloudWatch.ListTagsForResourcePolicyLive,
    CloudWatch.PutMetricDataPolicyLive,
    CloudWatch.SetAlarmStatePolicyLive,
  );

export const dynamoDbBindings = () =>
  Layer.mergeAll(
    DynamoDB.BatchExecuteStatementPolicyLive,
    DynamoDB.BatchGetItemPolicyLive,
    DynamoDB.BatchWriteItemPolicyLive,
    DynamoDB.DeleteItemPolicyLive,
    DynamoDB.DescribeTablePolicyLive,
    DynamoDB.DescribeTimeToLivePolicyLive,
    DynamoDB.ExecuteStatementPolicyLive,
    DynamoDB.ExecuteTransactionPolicyLive,
    DynamoDB.GetItemPolicyLive,
    DynamoDB.ListTablesPolicyLive,
    DynamoDB.ListTagsOfResourcePolicyLive,
    DynamoDB.PutItemPolicyLive,
    DynamoDB.QueryPolicyLive,
    DynamoDB.RestoreTableToPointInTimePolicyLive,
    DynamoDB.ScanPolicyLive,
    DynamoDB.TransactGetItemsPolicyLive,
    DynamoDB.TransactWriteItemsPolicyLive,
    DynamoDB.UpdateItemPolicyLive,
    DynamoDB.UpdateTimeToLivePolicyLive,
  );

export const ecsBindings = () =>
  Layer.mergeAll(
    ECS.DescribeTasksPolicyLive,
    ECS.ListTasksPolicyLive,
    ECS.RunTaskPolicyLive,
    ECS.StopTaskPolicyLive,
  );

export const eventBridgeBindings = () =>
  Layer.mergeAll(
    EventBridge.DescribeEventBusPolicyLive,
    EventBridge.DescribeRulePolicyLive,
    EventBridge.ListEventBusesPolicyLive,
    EventBridge.ListRulesPolicyLive,
    EventBridge.ListTargetsByRulePolicyLive,
    EventBridge.PutEventsPolicyLive,
    EventBridge.TestEventPatternPolicyLive,
    EventBridge.ToLambdaPolicyLive,
    EventBridge.ToQueuePolicyLive,
  );

export const kinesisBindings = () =>
  Layer.mergeAll(
    Kinesis.DescribeAccountSettingsPolicyLive,
    Kinesis.DescribeLimitsPolicyLive,
    Kinesis.DescribeStreamConsumerPolicyLive,
    Kinesis.DescribeStreamPolicyLive,
    Kinesis.DescribeStreamSummaryPolicyLive,
    Kinesis.GetRecordsPolicyLive,
    Kinesis.GetResourcePolicyPolicyLive,
    Kinesis.GetShardIteratorPolicyLive,
    Kinesis.ListShardsPolicyLive,
    Kinesis.ListStreamConsumersPolicyLive,
    Kinesis.ListStreamsPolicyLive,
    Kinesis.ListTagsForResourcePolicyLive,
    Kinesis.PutRecordPolicyLive,
    Kinesis.PutRecordsPolicyLive,
    Kinesis.StreamSinkPolicyLive,
    Kinesis.SubscribeToShardPolicyLive,
  );

export const lambdaBindings = () =>
  Layer.mergeAll(
    Lambda.BucketEventSourcePolicyLive,
    Lambda.QueueEventSourcePolicyLive,
    Lambda.StreamEventSourcePolicyLive,
    Lambda.TableEventSourcePolicyLive,
    Lambda.TopicEventSourcePolicyLive,
  );

export const rdsBindings = () => Layer.mergeAll(RDS.ConnectPolicyLive);

export const rdsDataBindings = () =>
  Layer.mergeAll(
    RDSData.BatchExecuteStatementPolicyLive,
    RDSData.BeginTransactionPolicyLive,
    RDSData.CommitTransactionPolicyLive,
    RDSData.ExecuteSqlPolicyLive,
    RDSData.ExecuteStatementPolicyLive,
    RDSData.RollbackTransactionPolicyLive,
  );

export const s3Bindings = () =>
  Layer.mergeAll(
    S3.AbortMultipartUploadPolicyLive,
    S3.CompleteMultipartUploadPolicyLive,
    S3.CreateMultipartUploadPolicyLive,
    S3.DeleteObjectPolicyLive,
    S3.GetObjectPolicyLive,
    S3.HeadObjectPolicyLive,
    S3.ListObjectsV2PolicyLive,
    S3.PutObjectPolicyLive,
    S3.UploadPartPolicyLive,
  );

export const secretsManagerBindings = () =>
  Layer.mergeAll(
    SecretsManager.DescribeSecretPolicyLive,
    SecretsManager.GetRandomPasswordPolicyLive,
    SecretsManager.GetSecretValuePolicyLive,
    SecretsManager.ListSecretsPolicyLive,
    SecretsManager.PutSecretValuePolicyLive,
  );

export const snsBindings = () =>
  Layer.mergeAll(
    SNS.AddPermissionPolicyLive,
    SNS.ConfirmSubscriptionPolicyLive,
    SNS.GetDataProtectionPolicyPolicyLive,
    SNS.GetSubscriptionAttributesPolicyLive,
    SNS.GetTopicAttributesPolicyLive,
    SNS.ListSubscriptionsByTopicPolicyLive,
    SNS.ListSubscriptionsPolicyLive,
    SNS.ListTagsForResourcePolicyLive,
    SNS.ListTopicsPolicyLive,
    SNS.PublishBatchPolicyLive,
    SNS.PublishPolicyLive,
    SNS.PutDataProtectionPolicyPolicyLive,
    SNS.RemovePermissionPolicyLive,
    SNS.SetSubscriptionAttributesPolicyLive,
    SNS.SetTopicAttributesPolicyLive,
    SNS.TagResourcePolicyLive,
    SNS.TopicSinkPolicyLive,
    SNS.UntagResourcePolicyLive,
  );

export const sqsBindings = () =>
  Layer.mergeAll(
    SQS.DeleteMessageBatchPolicyLive,
    SQS.QueueSinkPolicyLive,
    SQS.ReceiveMessagePolicyLive,
    SQS.SendMessageBatchPolicyLive,
    SQS.SendMessagePolicyLive,
    // SQS.QueueEventSourcePolicyLive,
  );
