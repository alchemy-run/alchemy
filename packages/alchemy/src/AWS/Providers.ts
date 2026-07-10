/** @effect-diagnostics layerMergeAllWithDependencies:off */
import {
  isRetryable,
  isThrottlingError,
  isTransientError,
} from "@distilled.cloud/aws/Category";
import {
  capped,
  jittered,
  Retry,
  type Factory as RetryFactory,
} from "@distilled.cloud/aws/Retry";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import { CredentialsStoreLive } from "../Auth/Credentials.ts";
import * as Command from "../Command/index.ts";
import { DockerLive } from "../Docker/Docker.ts";
import { KeyPair, KeyPairProvider } from "../KeyPair.ts";
import * as Provider from "../Provider.ts";
import { Random, RandomProvider } from "../Random.ts";
import * as AccessAnalyzer from "./AccessAnalyzer/index.ts";
import * as Account from "./Account/index.ts";
import * as ACM from "./ACM/index.ts";
import * as AMP from "./AMP/index.ts";
import * as Amplify from "./Amplify/index.ts";
import * as ApiGateway from "./ApiGateway/index.ts";
import * as ApiGatewayV2 from "./ApiGatewayV2/index.ts";
import * as AppConfig from "./AppConfig/index.ts";
import * as AppFlow from "./AppFlow/index.ts";
import * as ApplicationAutoScaling from "./ApplicationAutoScaling/index.ts";
import * as AppRunner from "./AppRunner/index.ts";
import * as AppSync from "./AppSync/index.ts";
import * as Assets from "./Assets.ts";
import * as Athena from "./Athena/index.ts";
import { AwsAuth } from "./AuthProvider.ts";
import * as AutoScaling from "./AutoScaling/index.ts";
import * as B2BI from "./B2BI/index.ts";
import * as Backup from "./Backup/index.ts";
import * as Batch from "./Batch/index.ts";
import * as Bedrock from "./Bedrock/index.ts";
import * as Budgets from "./Budgets/index.ts";
import * as CloudControl from "./CloudControl/index.ts";
import * as CloudFormation from "./CloudFormation/index.ts";
import * as CloudFront from "./CloudFront/index.ts";
import * as CloudMap from "./CloudMap/index.ts";
import * as CloudWatch from "./CloudWatch/index.ts";
import * as CodeArtifact from "./CodeArtifact/index.ts";
import * as CodeBuild from "./CodeBuild/index.ts";
import * as CodeConnections from "./CodeConnections/index.ts";
import * as CodeDeploy from "./CodeDeploy/index.ts";
import * as CodePipeline from "./CodePipeline/index.ts";
import * as Cognito from "./Cognito/index.ts";
import * as Credentials from "./Credentials.ts";
import * as DataSync from "./DataSync/index.ts";
import * as DMS from "./DMS/index.ts";
import * as Detective from "./Detective/index.ts";
import * as DocDB from "./DocDB/index.ts";
import * as DSQL from "./DSQL/index.ts";
import * as DynamoDB from "./DynamoDB/index.ts";
import * as EC2 from "./EC2/index.ts";
import * as ECR from "./ECR/index.ts";
import * as ECRPublic from "./ECRPublic/index.ts";
import * as ECS from "./ECS/index.ts";
import * as EFS from "./EFS/index.ts";
import * as EKS from "./EKS/index.ts";
import * as ElastiCache from "./ElastiCache/index.ts";
import * as ELBv2 from "./ELBv2/index.ts";
import * as Endpoint from "./Endpoint.ts";
import { Default as DefaultEnvironment } from "./Environment.ts";
import * as EventBridge from "./EventBridge/index.ts";
import * as FMS from "./FMS/index.ts";
import * as Firehose from "./Firehose/index.ts";
import * as Forecast from "./Forecast/index.ts";
import * as FraudDetector from "./FraudDetector/index.ts";
import * as FSx from "./FSx/index.ts";
import * as Glue from "./Glue/index.ts";
import * as Grafana from "./Grafana/index.ts";
import * as GuardDuty from "./GuardDuty/index.ts";
import * as IAM from "./IAM/index.ts";
import * as IdentityCenter from "./IdentityCenter/index.ts";
import * as Inspector2 from "./Inspector2/index.ts";
import * as IoT from "./IoT/index.ts";
import * as Kafka from "./Kafka/index.ts";
import * as Keyspaces from "./Keyspaces/index.ts";
import * as Kinesis from "./Kinesis/index.ts";
import * as KMS from "./KMS/index.ts";
import * as Lambda from "./Lambda/index.ts";
import * as Location from "./Location/index.ts";
import * as Logs from "./Logs/index.ts";
import * as MediaConvert from "./MediaConvert/index.ts";
import * as MQ from "./MQ/index.ts";
import * as MWAA from "./MWAA/index.ts";
import * as Macie2 from "./Macie2/index.ts";
import * as MemoryDB from "./MemoryDB/index.ts";
import * as OpenSearchServerless from "./OpenSearchServerless/index.ts";
import * as Organizations from "./Organizations/index.ts";
import * as Personalize from "./Personalize/index.ts";
import * as Pipes from "./Pipes/index.ts";
import * as QuickSight from "./QuickSight/index.ts";
import * as RAM from "./RAM/index.ts";
import * as RDS from "./RDS/index.ts";
import * as RedshiftServerless from "./RedshiftServerless/index.ts";
import * as Region from "./Region.ts";
import * as Route53 from "./Route53/index.ts";
import * as S3 from "./S3/index.ts";
import * as S3Vectors from "./S3Vectors/index.ts";
import * as Scheduler from "./Scheduler/index.ts";
import * as SecretsManager from "./SecretsManager/index.ts";
import * as SecurityHub from "./SecurityHub/index.ts";
import * as SES from "./SES/index.ts";
import * as SNS from "./SNS/index.ts";
import * as SQS from "./SQS/index.ts";
import * as SSM from "./SSM/index.ts";
import * as StepFunctions from "./StepFunctions/index.ts";
import * as Timestream from "./Timestream/index.ts";
import * as Transfer from "./Transfer/index.ts";
import * as VerifiedPermissions from "./VerifiedPermissions/index.ts";
import * as VpcLattice from "./VpcLattice/index.ts";
import * as WAFv2 from "./WAFv2/index.ts";
import * as Website from "./Website/index.ts";
import * as XRay from "./XRay/index.ts";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "AWS",
) {}

export const providers = () =>
  Layer.effect(
    Providers,
    Provider.collection([
      KeyPair,
      Random,
      AccessAnalyzer.Analyzer,
      AccessAnalyzer.ArchiveRule,
      Account.AlternateContact,
      ACM.Certificate,
      AMP.AlertManagerDefinition,
      AMP.RuleGroupsNamespace,
      AMP.Workspace,
      Amplify.App,
      ApiGateway.Account,
      ApiGateway.ApiKey,
      ApiGateway.Authorizer,
      ApiGateway.BasePathMapping,
      ApiGateway.DeploymentResource,
      ApiGateway.DomainName,
      ApiGateway.GatewayResponse,
      ApiGateway.MethodResource,
      ApiGateway.GatewayResource,
      ApiGateway.RestApi,
      ApiGateway.StageResource,
      ApiGateway.UsagePlan,
      ApiGateway.UsagePlanKey,
      ApiGateway.VpcLink,
      ApiGatewayV2.Api,
      ApiGatewayV2.ApiMappingResource,
      ApiGatewayV2.AuthorizerResource,
      ApiGatewayV2.DomainName,
      ApiGatewayV2.IntegrationResource,
      ApiGatewayV2.RouteResource,
      ApiGatewayV2.StageResource,
      ApiGatewayV2.VpcLink,
      AppConfig.Application,
      AppConfig.ConfigurationProfile,
      AppConfig.Deployment,
      AppConfig.DeploymentStrategy,
      AppConfig.Environment,
      AppConfig.HostedConfigurationVersion,
      AppFlow.ConnectorProfile,
      AppFlow.Flow,
      ApplicationAutoScaling.ScalableTarget,
      ApplicationAutoScaling.ScalingPolicy,
      ApplicationAutoScaling.ScheduledAction,
      AppRunner.AutoScalingConfiguration,
      AppRunner.Service,
      AppRunner.VpcConnector,
      AppSync.ApiAssociationResource,
      AppSync.ApiKeyResource,
      AppSync.DataSourceResource,
      AppSync.DomainName,
      AppSync.FunctionResource,
      AppSync.GraphqlApi,
      AppSync.ResolverResource,
      Athena.DataCatalog,
      Athena.NamedQuery,
      Athena.WorkGroup,
      AutoScaling.AutoScalingGroup,
      AutoScaling.LaunchTemplate,
      AutoScaling.LifecycleHook,
      AutoScaling.ScalingPolicy,
      AutoScaling.ScheduledAction,
      B2BI.Capability,
      B2BI.Partnership,
      B2BI.Profile,
      B2BI.Transformer,
      Backup.BackupPlan,
      Backup.BackupSelection,
      Backup.BackupVault,
      Batch.ComputeEnvironment,
      Batch.JobDefinition,
      Batch.JobQueue,
      Bedrock.Agent,
      Bedrock.AgentAlias,
      Bedrock.DataSource,
      Bedrock.KnowledgeBase,
      Budgets.Budget,
      CloudControl.Resource,
      CloudFormation.Stack,
      CloudFront.CachePolicy,
      CloudFront.Distribution,
      CloudFront.Function,
      CloudFront.Invalidation,
      CloudFront.KeyGroup,
      CloudFront.KeyValueStore,
      CloudFront.KvEntries,
      CloudFront.KvRoutesUpdate,
      CloudFront.OriginAccessControl,
      CloudFront.OriginRequestPolicy,
      CloudFront.PublicKey,
      CloudFront.RealtimeLogConfig,
      CloudFront.ResponseHeadersPolicy,
      CloudFront.VpcOrigin,
      CloudMap.HttpNamespace,
      CloudMap.InstanceRegistration,
      CloudMap.PrivateDnsNamespace,
      CloudMap.PublicDnsNamespace,
      CloudMap.Service,
      CloudWatch.Alarm,
      CloudWatch.AlarmMuteRule,
      CloudWatch.AnomalyDetector,
      CloudWatch.CompositeAlarm,
      CloudWatch.Dashboard,
      CloudWatch.InsightRule,
      CloudWatch.MetricStream,
      CodeArtifact.Domain,
      CodeArtifact.Repository,
      CodeBuild.Project,
      CodeConnections.Connection,
      CodeDeploy.Application,
      CodeDeploy.DeploymentGroup,
      CodePipeline.Pipeline,
      Cognito.Group,
      Cognito.IdentityPool,
      Cognito.IdentityPoolRoleAttachment,
      Cognito.IdentityProvider,
      Cognito.ResourceServer,
      Cognito.User,
      Cognito.UserPool,
      Cognito.UserPoolClient,
      Cognito.UserPoolDomain,
      DataSync.LocationEfs,
      DataSync.LocationS3,
      DataSync.Task,
      DocDB.DBCluster,
      DocDB.DBInstance,
      DocDB.DBSubnetGroup,
      DMS.Endpoint,
      DMS.ReplicationInstance,
      DMS.ReplicationSubnetGroup,
      DSQL.Cluster,
      Detective.Graph,
      DynamoDB.Table,
      EC2.DhcpOptions,
      EC2.EgressOnlyInternetGateway,
      EC2.EIP,
      EC2.FlowLog,
      EC2.Instance,
      EC2.InternetGateway,
      EC2.KeyPair,
      EC2.NatGateway,
      EC2.NetworkAcl,
      EC2.NetworkAclAssociation,
      EC2.NetworkAclEntry,
      EC2.NetworkInterface,
      EC2.NetworkInterfaceAttachment,
      EC2.PrefixList,
      EC2.Route,
      EC2.RouteTable,
      EC2.RouteTableAssociation,
      EC2.SecurityGroup,
      EC2.SecurityGroupRule,
      EC2.Snapshot,
      EC2.Subnet,
      EC2.Volume,
      EC2.VolumeAttachment,
      EC2.Vpc,
      EC2.VpcEndpoint,
      EC2.VpcPeeringConnection,
      ECR.Image,
      ECR.Repository,
      ECRPublic.PublicRepository,
      ECS.CapacityProvider,
      ECS.Cluster,
      ECS.Service,
      ECS.Task,
      ECS.TaskDefinition,
      EFS.AccessPoint,
      EFS.FileSystem,
      EFS.MountTarget,
      EKS.AccessEntry,
      EKS.Addon,
      EKS.Cluster,
      EKS.FargateProfile,
      EKS.Nodegroup,
      EKS.PodIdentityAssociation,
      EKS.ServerHost,
      ElastiCache.ServerlessCache,
      ELBv2.Listener,
      ELBv2.ListenerCertificate,
      ELBv2.ListenerRule,
      ELBv2.LoadBalancer,
      ELBv2.TargetGroup,
      ELBv2.TargetGroupAttachment,
      ELBv2.TrustStore,
      EventBridge.EventBus,
      EventBridge.Permission,
      EventBridge.Rule,
      FMS.AdminAccount,
      Firehose.DeliveryStream,
      FSx.FileSystem,
      Forecast.Dataset,
      Forecast.DatasetGroup,
      FraudDetector.Detector,
      FraudDetector.DetectorVersion,
      FraudDetector.EntityType,
      FraudDetector.EventType,
      FraudDetector.Label,
      FraudDetector.Outcome,
      FraudDetector.Variable,
      Glue.Connection,
      Glue.Crawler,
      Glue.Database,
      Glue.Job,
      Glue.Table,
      Grafana.Workspace,
      GuardDuty.Detector,
      IAM.AccessKey,
      IAM.AccountAlias,
      IAM.AccountPasswordPolicy,
      IAM.Group,
      IAM.GroupMembership,
      IAM.InstanceProfile,
      IAM.LoginProfile,
      IAM.OpenIDConnectProvider,
      IAM.Policy,
      IAM.Role,
      IAM.SAMLProvider,
      IAM.ServerCertificate,
      IAM.ServiceLinkedRole,
      IAM.ServiceSpecificCredential,
      IAM.SigningCertificate,
      IAM.SSHPublicKey,
      IAM.User,
      IAM.VirtualMFADevice,
      IdentityCenter.AccountAssignment,
      IdentityCenter.Group,
      IdentityCenter.Instance,
      Inspector2.Enabler,
      IdentityCenter.PermissionSet,
      IoT.Policy,
      IoT.Thing,
      IoT.ThingType,
      IoT.TopicRule,
      Kafka.ServerlessCluster,
      Keyspaces.Keyspace,
      Keyspaces.Table,
      KMS.Alias,
      KMS.Key,
      Kinesis.Stream,
      Kinesis.StreamConsumer,
      Lambda.Alias,
      Lambda.EventSourceMapping,
      Lambda.Function,
      Lambda.MicrovmImage,
      Lambda.NetworkConnector,
      Lambda.Permission,
      Location.GeofenceCollection,
      Location.Map,
      Location.PlaceIndex,
      Location.RouteCalculator,
      Location.Tracker,
      Logs.Destination,
      Logs.LogGroup,
      Logs.LogStream,
      Logs.MetricFilter,
      Logs.ResourcePolicy,
      Logs.SubscriptionFilter,
      MediaConvert.Job,
      MediaConvert.JobTemplate,
      MediaConvert.Preset,
      MediaConvert.Queue,
      MQ.Broker,
      MQ.Configuration,
      MWAA.Environment,
      Macie2.Session,
      Macie2.ClassificationJob,
      MemoryDB.ACL,
      MemoryDB.Cluster,
      MemoryDB.SubnetGroup,
      MemoryDB.User,
      OpenSearchServerless.AccessPolicy,
      OpenSearchServerless.Collection,
      OpenSearchServerless.SecurityPolicy,
      OpenSearchServerless.VpcEndpoint,
      Organizations.Account,
      Organizations.DelegatedAdministrator,
      Organizations.Organization,
      Organizations.OrganizationalUnit,
      Organizations.OrganizationResourcePolicy,
      Organizations.Policy,
      Organizations.PolicyAttachment,
      Organizations.Root,
      Organizations.RootPolicyType,
      Organizations.TrustedServiceAccess,
      Personalize.Dataset,
      Personalize.DatasetGroup,
      Personalize.Schema,
      Pipes.Pipe,
      QuickSight.Analysis,
      QuickSight.Dashboard,
      QuickSight.DataSet,
      QuickSight.DataSource,
      RAM.ResourceShare,
      RDS.DBCluster,
      RDS.DBClusterEndpoint,
      RDS.DBClusterParameterGroup,
      RDS.DBInstance,
      RDS.DBParameterGroup,
      RDS.DBProxy,
      RDS.DBProxyEndpoint,
      RDS.DBProxyTargetGroup,
      RDS.DBSubnetGroup,
      RedshiftServerless.Namespace,
      RedshiftServerless.Workgroup,
      Route53.HealthCheck,
      Route53.HostedZone,
      Route53.QueryLoggingConfig,
      Route53.Record,
      Route53.VpcAssociationAuthorization,
      Route53.ZoneVpcAssociation,
      S3.Bucket,
      S3Vectors.VectorBucket,
      S3Vectors.Index,
      Scheduler.Schedule,
      Scheduler.ScheduleGroup,
      SecurityHub.Hub,
      SecretsManager.Secret,
      SES.ConfigurationSet,
      SES.ConfigurationSetEventDestination,
      SES.EmailIdentity,
      SES.EmailTemplate,
      SNS.Subscription,
      SNS.Topic,
      SQS.Queue,
      SSM.Parameter,
      StepFunctions.Activity,
      StepFunctions.StateMachine,
      Timestream.Database,
      Timestream.DbInstance,
      Timestream.Table,
      Transfer.Server,
      Transfer.User,
      VerifiedPermissions.Policy,
      VerifiedPermissions.PolicyStore,
      VerifiedPermissions.Schema,
      VpcLattice.Service,
      VpcLattice.ServiceNetwork,
      VpcLattice.ServiceNetworkVpcAssociation,
      WAFv2.IPSet,
      WAFv2.RuleGroup,
      WAFv2.WebACL,
      WAFv2.WebACLAssociation,
      Website.AssetDeployment,
      XRay.Group,
      XRay.SamplingRule,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mergeAll(
          AppFlow.ConnectorProfileProvider(),
          AppFlow.FlowProvider(),
          B2BI.CapabilityProvider(),
          B2BI.PartnershipProvider(),
          B2BI.ProfileProvider(),
          B2BI.TransformerProvider(),
        ),
        Layer.mergeAll(
          ACM.CertificateProvider(),
          AMP.AlertManagerDefinitionProvider(),
          AMP.RuleGroupsNamespaceProvider(),
          AMP.WorkspaceProvider(),
          ApiGateway.AccountProvider(),
          ApiGateway.ApiKeyProvider(),
          ApiGateway.AuthorizerProvider(),
          ApiGateway.BasePathMappingProvider(),
          ApiGateway.DeploymentProvider(),
          ApiGateway.DomainNameProvider(),
          ApiGateway.GatewayResponseProvider(),
          ApiGateway.MethodProvider(),
          ApiGateway.ResourceProvider(),
          ApiGateway.RestApiProvider(),
          ApiGateway.StageProvider(),
          ApiGateway.UsagePlanProvider(),
          ApiGateway.UsagePlanKeyProvider(),
          ApiGateway.VpcLinkProvider(),
          ApiGatewayV2.ApiProvider(),
          ApiGatewayV2.ApiMappingProvider(),
          ApiGatewayV2.AuthorizerProvider(),
          ApiGatewayV2.DomainNameProvider(),
          ApiGatewayV2.IntegrationProvider(),
          ApiGatewayV2.RouteProvider(),
          ApiGatewayV2.StageProvider(),
          ApiGatewayV2.VpcLinkProvider(),
          AppConfig.ApplicationProvider(),
          AppConfig.ConfigurationProfileProvider(),
          AppConfig.DeploymentProvider(),
          AppConfig.DeploymentStrategyProvider(),
          AppConfig.EnvironmentProvider(),
          AppConfig.HostedConfigurationVersionProvider(),
          ApplicationAutoScaling.ScalableTargetProvider(),
          ApplicationAutoScaling.ScalingPolicyProvider(),
          ApplicationAutoScaling.ScheduledActionProvider(),
          AppRunner.AutoScalingConfigurationProvider(),
          AppRunner.ServiceProvider(),
          AppRunner.VpcConnectorProvider(),
          AppSync.ApiAssociationProvider(),
          AppSync.ApiKeyProvider(),
          AppSync.DataSourceProvider(),
          AppSync.DomainNameProvider(),
          AppSync.FunctionProvider(),
          AppSync.GraphqlApiProvider(),
          AppSync.ResolverProvider(),
          Athena.DataCatalogProvider(),
          Athena.NamedQueryProvider(),
          Athena.WorkGroupProvider(),
          AutoScaling.AutoScalingGroupProvider(),
          AutoScaling.LaunchTemplateProvider(),
          AutoScaling.LifecycleHookProvider(),
          AutoScaling.ScalingPolicyProvider(),
          AutoScaling.ScheduledActionProvider(),
          Batch.ComputeEnvironmentProvider(),
          Batch.JobDefinitionProvider(),
          Batch.JobQueueProvider(),
          CloudControl.CloudControlResourceProvider(),
          CloudFormation.StackProvider(),
          CloudFront.CachePolicyProvider(),
          CloudFront.DistributionProvider(),
          CloudFront.FunctionProvider(),
          CloudFront.InvalidationProvider(),
          CloudFront.KeyGroupProvider(),
          CloudFront.KeyValueStoreProvider(),
          CloudFront.KvEntriesProvider(),
          CloudFront.KvRoutesUpdateProvider(),
          CloudFront.OriginAccessControlProvider(),
          CloudFront.OriginRequestPolicyProvider(),
          CloudFront.PublicKeyProvider(),
          CloudFront.RealtimeLogConfigProvider(),
          CloudFront.ResponseHeadersPolicyProvider(),
          CloudFront.VpcOriginProvider(),
          CloudMap.HttpNamespaceProvider(),
          CloudMap.InstanceRegistrationProvider(),
          CloudMap.PrivateDnsNamespaceProvider(),
          CloudMap.PublicDnsNamespaceProvider(),
          CloudMap.ServiceProvider(),
          CloudWatch.AlarmMuteRuleProvider(),
          CloudWatch.AlarmProvider(),
          CloudWatch.AnomalyDetectorProvider(),
          CloudWatch.CompositeAlarmProvider(),
          CloudWatch.DashboardProvider(),
          CloudWatch.InsightRuleProvider(),
          CloudWatch.MetricStreamProvider(),
          CodeArtifact.DomainProvider(),
          CodeArtifact.RepositoryProvider(),
          CodeBuild.ProjectProvider(),
          CodeConnections.ConnectionProvider(),
          CodeDeploy.ApplicationProvider(),
          CodeDeploy.DeploymentGroupProvider(),
          CodePipeline.PipelineProvider(),
          Cognito.GroupProvider(),
          Cognito.IdentityPoolProvider(),
          Cognito.IdentityPoolRoleAttachmentProvider(),
          Cognito.IdentityProviderProvider(),
          Cognito.ResourceServerProvider(),
          Cognito.UserPoolClientProvider(),
          Cognito.UserProvider(),
          Cognito.UserPoolDomainProvider(),
          Cognito.UserPoolProvider(),
        ),
        Layer.mergeAll(
          DataSync.LocationEfsProvider(),
          DataSync.LocationS3Provider(),
          DataSync.TaskProvider(),
          DocDB.DBClusterProvider(),
          DocDB.DBInstanceProvider(),
          DocDB.DBSubnetGroupProvider(),
          DMS.EndpointProvider(),
          DMS.ReplicationInstanceProvider(),
          DMS.ReplicationSubnetGroupProvider(),
          DSQL.ClusterProvider(),
          DynamoDB.TableProvider(),
          EC2.DhcpOptionsProvider(),
          EC2.EgressOnlyInternetGatewayProvider(),
          EC2.EIPProvider(),
          EC2.FlowLogProvider(),
          EC2.InstanceProvider(),
          EC2.InternetGatewayProvider(),
          EC2.KeyPairProvider(),
          EC2.NatGatewayProvider(),
          EC2.NetworkAclAssociationProvider(),
          EC2.NetworkAclEntryProvider(),
          EC2.NetworkAclProvider(),
          EC2.NetworkInterfaceProvider(),
          EC2.NetworkInterfaceAttachmentProvider(),
          EC2.PrefixListProvider(),
          EC2.RouteProvider(),
          EC2.RouteTableAssociationProvider(),
          EC2.RouteTableProvider(),
          EC2.SecurityGroupProvider(),
          EC2.SecurityGroupRuleProvider(),
          EC2.SnapshotProvider(),
          EC2.SubnetProvider(),
          EC2.VolumeProvider(),
          EC2.VolumeAttachmentProvider(),
          EC2.VpcEndpointProvider(),
          EC2.VpcPeeringConnectionProvider(),
          EC2.VpcProvider(),
          ECR.ImageProvider(),
          ECR.RepositoryProvider(),
          ECS.CapacityProviderProvider(),
          ECS.ClusterProvider(),
          ECS.ServiceProvider(),
          ECS.TaskDefinitionProvider(),
          ECS.TaskProvider(),
          EFS.AccessPointProvider(),
          EFS.FileSystemProvider(),
          EFS.MountTargetProvider(),
          EKS.AccessEntryProvider(),
          EKS.AddonProvider(),
          EKS.ClusterProvider(),
          EKS.FargateProfileProvider(),
          EKS.NodegroupProvider(),
          EKS.PodIdentityAssociationProvider(),
          EKS.ServerHostProvider(),
          ElastiCache.ServerlessCacheProvider(),
          ELBv2.ListenerProvider(),
          ELBv2.ListenerCertificateProvider(),
          ELBv2.ListenerRuleProvider(),
          ELBv2.LoadBalancerProvider(),
          ELBv2.TargetGroupProvider(),
          ELBv2.TargetGroupAttachmentProvider(),
          ELBv2.TrustStoreProvider(),
          EventBridge.EventBusProvider(),
          EventBridge.PermissionProvider(),
          EventBridge.RuleProvider(),
          Firehose.DeliveryStreamProvider(),
          FSx.FileSystemProvider(),
          Glue.ConnectionProvider(),
          Glue.CrawlerProvider(),
          Glue.DatabaseProvider(),
          Glue.JobProvider(),
          Glue.TableProvider(),
          Grafana.WorkspaceProvider(),
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
          IAM.ServiceLinkedRoleProvider(),
          IAM.ServiceSpecificCredentialProvider(),
          IAM.SigningCertificateProvider(),
          IAM.SSHPublicKeyProvider(),
          IAM.UserProvider(),
          IAM.VirtualMFADeviceProvider(),
        ),
        Layer.mergeAll(
          IdentityCenter.AccountAssignmentProvider(),
          IdentityCenter.GroupProvider(),
          IdentityCenter.InstanceProvider(),
          IdentityCenter.PermissionSetProvider(),
          Kafka.ServerlessClusterProvider(),
          Keyspaces.KeyspaceProvider(),
          Keyspaces.TableProvider(),
          KMS.AliasProvider(),
          KMS.KeyProvider(),
          Kinesis.StreamConsumerProvider(),
          Kinesis.StreamProvider(),
          Lambda.AliasProvider(),
          Lambda.EventSourceMappingProvider(),
          Lambda.FunctionProvider(),
          Lambda.MicrovmImageProvider(),
          Lambda.NetworkConnectorProvider(),
          Lambda.PermissionProvider(),
          Logs.DestinationProvider(),
          Logs.LogGroupProvider(),
          Logs.LogStreamProvider(),
          Logs.MetricFilterProvider(),
          Logs.ResourcePolicyProvider(),
          Logs.SubscriptionFilterProvider(),
          MediaConvert.JobProvider(),
          MediaConvert.JobTemplateProvider(),
          MediaConvert.PresetProvider(),
          MediaConvert.QueueProvider(),
          MQ.BrokerProvider(),
          MQ.ConfigurationProvider(),
          MemoryDB.ACLProvider(),
          MemoryDB.ClusterProvider(),
          MemoryDB.SubnetGroupProvider(),
          MemoryDB.UserProvider(),
          OpenSearchServerless.AccessPolicyProvider(),
          OpenSearchServerless.CollectionProvider(),
          OpenSearchServerless.SecurityPolicyProvider(),
          OpenSearchServerless.VpcEndpointProvider(),
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
          Pipes.PipeProvider(),
          QuickSight.AnalysisProvider(),
          QuickSight.DashboardProvider(),
          QuickSight.DataSetProvider(),
          QuickSight.DataSourceProvider(),
          RDS.DBClusterEndpointProvider(),
          RDS.DBClusterParameterGroupProvider(),
          RDS.DBClusterProvider(),
          RDS.DBInstanceProvider(),
          RDS.DBParameterGroupProvider(),
          RDS.DBProxyEndpointProvider(),
          RDS.DBProxyProvider(),
          RDS.DBProxyTargetGroupProvider(),
          RDS.DBSubnetGroupProvider(),
          RedshiftServerless.NamespaceProvider(),
          RedshiftServerless.WorkgroupProvider(),
          Route53.HealthCheckProvider(),
          Route53.HostedZoneProvider(),
          Route53.QueryLoggingConfigProvider(),
          Route53.RecordProvider(),
          Route53.VpcAssociationAuthorizationProvider(),
          Route53.ZoneVpcAssociationProvider(),
          S3.BucketProvider(),
          Scheduler.ScheduleGroupProvider(),
          Scheduler.ScheduleProvider(),
          SecretsManager.SecretProvider(),
          SES.ConfigurationSetEventDestinationProvider(),
          SES.ConfigurationSetProvider(),
          SES.EmailIdentityProvider(),
          SES.EmailTemplateProvider(),
          SNS.SubscriptionProvider(),
          SNS.TopicProvider(),
          SQS.QueueProvider(),
          SSM.ParameterProvider(),
          StepFunctions.ActivityProvider(),
          StepFunctions.StateMachineProvider(),
          WAFv2.IPSetProvider(),
          WAFv2.RuleGroupProvider(),
          WAFv2.WebACLAssociationProvider(),
          WAFv2.WebACLProvider(),
          Website.AssetDeploymentProvider(),
          XRay.GroupProvider(),
          XRay.SamplingRuleProvider(),
          Bedrock.AgentProvider(),
          Bedrock.AgentAliasProvider(),
          Bedrock.DataSourceProvider(),
          Bedrock.KnowledgeBaseProvider(),
          AccessAnalyzer.AnalyzerProvider(),
          AccessAnalyzer.ArchiveRuleProvider(),
          Transfer.ServerProvider(),
          Transfer.UserProvider(),
          VerifiedPermissions.PolicyProvider(),
          VerifiedPermissions.PolicyStoreProvider(),
          VerifiedPermissions.SchemaProvider(),
          Backup.BackupVaultProvider(),
          Backup.BackupPlanProvider(),
          Backup.BackupSelectionProvider(),
          Budgets.BudgetProvider(),
          GuardDuty.DetectorProvider(),
          Inspector2.EnablerProvider(),
          SecurityHub.HubProvider(),
          Detective.GraphProvider(),
          FMS.AdminAccountProvider(),
          Macie2.SessionProvider(),
          Macie2.ClassificationJobProvider(),
          RAM.ResourceShareProvider(),
        ),
        Layer.mergeAll(
          S3Vectors.VectorBucketProvider(),
          S3Vectors.IndexProvider(),
          Account.AlternateContactProvider(),
          Amplify.AppProvider(),
          ECRPublic.PublicRepositoryProvider(),
          VpcLattice.ServiceNetworkProvider(),
          VpcLattice.ServiceProvider(),
          VpcLattice.ServiceNetworkVpcAssociationProvider(),
          MWAA.EnvironmentProvider(),
          Location.MapProvider(),
          Location.PlaceIndexProvider(),
          Location.RouteCalculatorProvider(),
          Location.GeofenceCollectionProvider(),
          Location.TrackerProvider(),
          Forecast.DatasetGroupProvider(),
          Forecast.DatasetProvider(),
          FraudDetector.DetectorProvider(),
          FraudDetector.DetectorVersionProvider(),
          FraudDetector.EntityTypeProvider(),
          FraudDetector.EventTypeProvider(),
          FraudDetector.LabelProvider(),
          FraudDetector.OutcomeProvider(),
          FraudDetector.VariableProvider(),
          Personalize.SchemaProvider(),
          Personalize.DatasetGroupProvider(),
          Personalize.DatasetProvider(),
          IoT.ThingProvider(),
          IoT.ThingTypeProvider(),
          IoT.PolicyProvider(),
          IoT.TopicRuleProvider(),
        ),
        Layer.mergeAll(
          Timestream.DatabaseProvider(),
          Timestream.DbInstanceProvider(),
          Timestream.TableProvider(),
        ),
      ),
    ),
    Layer.provideMerge(
      Layer.mergeAll(
        Command.providers(),
        KeyPairProvider(),
        RandomProvider(),
        Assets.AssetsLive,
        DockerLive,
      ),
    ),
    Layer.provideMerge(Region.fromEnvironment),
    Layer.provideMerge(Credentials.fromEnvironment),
    Layer.provideMerge(Endpoint.fromEnvironment),
    Layer.provideMerge(DefaultEnvironment),
    Layer.provideMerge(AwsAuth),
    Layer.provideMerge(CredentialsStoreLive),
    // Apply a blanket retry policy to every AWS SDK call. Like distilled's
    // `makeDefault` it retries throttling, 5xx, and Smithy `@retryable`
    // errors with exponential backoff + jitter + `RetryAfter` header
    // awareness, but with a higher attempt cap (10 vs 5) so heavy
    // parallel deploys ride out S3 `SlowDown` bursts that span more than
    // a few seconds. Bounded so real rate-limit pressure still surfaces
    // instead of masking as an indefinite hang.
    Layer.provideMerge(Layer.succeed(Retry, awsRetryFactory)),
    Layer.orDie,
  );

// Node socket-level error codes that indicate a transient network failure.
const TRANSIENT_NETWORK_CODES = new Set([
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ENETUNREACH",
  "ENETDOWN",
  "EHOSTUNREACH",
  "EAI_AGAIN",
]);
// Transport-termination signatures that undici/node surface as plain messages
// (e.g. a `fetch` whose socket dies mid-body throws `TypeError: terminated`).
const TRANSIENT_NETWORK_PATTERN =
  /terminated|socket hang up|other side closed|fetch failed|read ETIMEDOUT|ECONNRESET|ETIMEDOUT/i;

// Walk an error's cause chain looking for a transient transport failure. Used
// to tell a Decode/EmptyBody error caused by a dropped connection (retryable)
// apart from one caused by a genuinely malformed body (permanent).
const hasTransientNetworkCause = (cause: unknown, depth = 0): boolean => {
  if (cause == null || depth > 8) return false;
  if (typeof cause === "string") return TRANSIENT_NETWORK_PATTERN.test(cause);
  if (typeof cause !== "object") return false;
  const code = (cause as { code?: unknown }).code;
  if (typeof code === "string" && TRANSIENT_NETWORK_CODES.has(code)) {
    return true;
  }
  const message = (cause as { message?: unknown }).message;
  if (typeof message === "string" && TRANSIENT_NETWORK_PATTERN.test(message)) {
    return true;
  }
  const nested = (cause as { cause?: unknown }).cause;
  return nested !== undefined && nested !== cause
    ? hasTransientNetworkCause(nested, depth + 1)
    : false;
};

// TODO(sam): remove this once it's upstreamed to distilled
const isHttpTransportError = (error: unknown): boolean => {
  if (!HttpClientError.isHttpClientError(error)) return false;
  const reason = error.reason;
  const tag = reason._tag;
  if (tag === "TransportError") return true;
  // A Decode/EmptyBody error is only transient when its underlying cause is a
  // terminated/reset connection (e.g. a `read ETIMEDOUT` while streaming the
  // body surfaces as a `DecodeError`). A genuine malformed-body decode is
  // permanent — retrying it would only waste the budget and mask the bug — so
  // gate on the cause chain rather than the tag.
  if (tag === "DecodeError" || tag === "EmptyBodyError") {
    return hasTransientNetworkCause(reason);
  }
  if (
    tag === "StatusCodeError" &&
    "response" in error.reason &&
    error.reason.response.status >= 500
  ) {
    return true;
  }
  return false;
};

const awsRetryFactory: RetryFactory = (lastError) => ({
  while: (error) =>
    isTransientError(error) ||
    isThrottlingError(error) ||
    isRetryable(error) ||
    isHttpTransportError(error),
  schedule: pipe(
    Schedule.exponential(Duration.millis(200), 2),
    Schedule.modifyDelay(
      Effect.fn(function* (duration) {
        const error = yield* Ref.get(lastError);
        if (isThrottlingError(error)) {
          // Throttling: floor at 500ms (matches distilled default).
          if (Duration.toMillis(duration) < 500) {
            return Duration.toMillis(Duration.millis(500));
          }
        }
        return Duration.toMillis(duration);
      }),
    ),
    capped(Duration.seconds(5)),
    jittered,
    // Transient transport failures (e.g. a sustained `read ETIMEDOUT` blip
    // against a control-plane endpoint) can outlast a 10-attempt budget. With
    // the 5s cap above, the extra attempts add bounded backoff while making
    // the network-flake recovery materially more robust.
    Schedule.both(Schedule.recurs(15)),
  ),
});
