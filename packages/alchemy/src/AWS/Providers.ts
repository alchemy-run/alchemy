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
import { KeyPair, KeyPairProvider } from "../KeyPair.ts";
import * as Provider from "../Provider.ts";
import { Random, RandomProvider } from "../Random.ts";
import * as ACM from "./ACM/index.ts";
import * as ApiGateway from "./ApiGateway/index.ts";
import * as Assets from "./Assets.ts";
import { AwsAuth } from "./AuthProvider.ts";
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
import { Default as DefaultEnvironment } from "./Environment.ts";
import * as EventBridge from "./EventBridge/index.ts";
import * as IAM from "./IAM/index.ts";
import * as IdentityCenter from "./IdentityCenter/index.ts";
import * as Kinesis from "./Kinesis/index.ts";
import * as KMS from "./KMS/index.ts";
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
import * as Website from "./Website/index.ts";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "AWS",
) {}

export const providers = () =>
  Layer.effect(
    Providers,
    Provider.collection([
      KeyPair,
      Random,
      ACM.Certificate,
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
      AutoScaling.AutoScalingGroup,
      AutoScaling.LaunchTemplate,
      AutoScaling.ScalingPolicy,
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
      CloudFront.ResponseHeadersPolicy,
      CloudFront.VpcOrigin,
      CloudWatch.Alarm,
      CloudWatch.AlarmMuteRule,
      CloudWatch.AnomalyDetector,
      CloudWatch.CompositeAlarm,
      CloudWatch.Dashboard,
      CloudWatch.InsightRule,
      CloudWatch.MetricStream,
      DynamoDB.Table,
      EC2.EgressOnlyInternetGateway,
      EC2.EIP,
      EC2.Instance,
      EC2.InternetGateway,
      EC2.NatGateway,
      EC2.NetworkAcl,
      EC2.NetworkAclAssociation,
      EC2.NetworkAclEntry,
      EC2.Route,
      EC2.RouteTable,
      EC2.RouteTableAssociation,
      EC2.SecurityGroup,
      EC2.SecurityGroupRule,
      EC2.Subnet,
      EC2.Vpc,
      EC2.VpcEndpoint,
      ECR.Repository,
      ECS.CapacityProvider,
      ECS.Cluster,
      ECS.Service,
      ECS.Task,
      EKS.AccessEntry,
      EKS.Addon,
      EKS.Cluster,
      EKS.PodIdentityAssociation,
      ELBv2.Listener,
      ELBv2.ListenerRule,
      ELBv2.LoadBalancer,
      ELBv2.TargetGroup,
      ELBv2.TrustStore,
      EventBridge.EventBus,
      EventBridge.Permission,
      EventBridge.Rule,
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
      IAM.ServiceSpecificCredential,
      IAM.SigningCertificate,
      IAM.SSHPublicKey,
      IAM.User,
      IAM.VirtualMFADevice,
      IdentityCenter.AccountAssignment,
      IdentityCenter.Group,
      IdentityCenter.Instance,
      IdentityCenter.PermissionSet,
      KMS.Alias,
      KMS.Key,
      Kinesis.Stream,
      Kinesis.StreamConsumer,
      Lambda.Alias,
      Lambda.EventSourceMapping,
      Lambda.Function,
      Lambda.Permission,
      Logs.LogGroup,
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
      RDS.DBCluster,
      RDS.DBClusterEndpoint,
      RDS.DBClusterParameterGroup,
      RDS.DBInstance,
      RDS.DBParameterGroup,
      RDS.DBProxy,
      RDS.DBProxyEndpoint,
      RDS.DBProxyTargetGroup,
      RDS.DBSubnetGroup,
      Route53.HealthCheck,
      Route53.HostedZone,
      Route53.Record,
      S3.Bucket,
      Scheduler.Schedule,
      Scheduler.ScheduleGroup,
      SecretsManager.Secret,
      SNS.Subscription,
      SNS.Topic,
      SQS.Queue,
      Website.AssetDeployment,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        ACM.CertificateProvider(),
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
        AutoScaling.AutoScalingGroupProvider(),
        AutoScaling.LaunchTemplateProvider(),
        AutoScaling.ScalingPolicyProvider(),
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
        CloudFront.ResponseHeadersPolicyProvider(),
        CloudFront.VpcOriginProvider(),
        CloudWatch.AlarmMuteRuleProvider(),
        CloudWatch.AlarmProvider(),
        CloudWatch.AnomalyDetectorProvider(),
        CloudWatch.CompositeAlarmProvider(),
        CloudWatch.DashboardProvider(),
        CloudWatch.InsightRuleProvider(),
        CloudWatch.MetricStreamProvider(),
        DynamoDB.TableProvider(),
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
        ECR.RepositoryProvider(),
        ECS.CapacityProviderProvider(),
        ECS.ClusterProvider(),
        ECS.ServiceProvider(),
        ECS.TaskProvider(),
        EKS.AccessEntryProvider(),
        EKS.AddonProvider(),
        EKS.ClusterProvider(),
        EKS.PodIdentityAssociationProvider(),
        ELBv2.ListenerProvider(),
        ELBv2.ListenerRuleProvider(),
        ELBv2.LoadBalancerProvider(),
        ELBv2.TargetGroupProvider(),
        ELBv2.TrustStoreProvider(),
        EventBridge.EventBusProvider(),
        EventBridge.PermissionProvider(),
        EventBridge.RuleProvider(),
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
        IdentityCenter.AccountAssignmentProvider(),
        IdentityCenter.GroupProvider(),
        IdentityCenter.InstanceProvider(),
        IdentityCenter.PermissionSetProvider(),
        KMS.AliasProvider(),
        KMS.KeyProvider(),
        Kinesis.StreamConsumerProvider(),
        Kinesis.StreamProvider(),
        Lambda.AliasProvider(),
        Lambda.EventSourceMappingProvider(),
        Lambda.FunctionProvider(),
        Lambda.PermissionProvider(),
        Logs.LogGroupProvider(),
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
        RDS.DBClusterEndpointProvider(),
        RDS.DBClusterParameterGroupProvider(),
        RDS.DBClusterProvider(),
        RDS.DBInstanceProvider(),
        RDS.DBParameterGroupProvider(),
        RDS.DBProxyEndpointProvider(),
        RDS.DBProxyProvider(),
        RDS.DBProxyTargetGroupProvider(),
        RDS.DBSubnetGroupProvider(),
        Route53.HealthCheckProvider(),
        Route53.HostedZoneProvider(),
        Route53.RecordProvider(),
        S3.BucketProvider(),
        Scheduler.ScheduleGroupProvider(),
        Scheduler.ScheduleProvider(),
        SecretsManager.SecretProvider(),
        SNS.SubscriptionProvider(),
        SNS.TopicProvider(),
        SQS.QueueProvider(),
        Website.AssetDeploymentProvider(),
      ),
    ),
    Layer.provideMerge(
      Layer.mergeAll(
        Command.providers(),
        KeyPairProvider(),
        RandomProvider(),
        Assets.AssetsLive,
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
