import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as Layer from "effect/Layer";
import { rolldown } from "../Bundle/Rolldown.ts";
import type { Provider } from "../Provider.ts";
import * as Account from "./Account.ts";
import * as Assets from "./Assets.ts";
import * as Credentials from "./Credentials.ts";
import * as DynamoDB from "./DynamoDB/index.ts";
import * as EC2 from "./EC2/index.ts";
import * as Endpoint from "./Endpoint.ts";
import * as Kinesis from "./Kinesis/index.ts";
import * as Lambda from "./Lambda/index.ts";
import * as Region from "./Region.ts";
import * as S3 from "./S3/index.ts";
import * as SNS from "./SNS/index.ts";
import * as SQS from "./SQS/index.ts";
import { loadDefaultStageConfig, StageConfig } from "./StageConfig.ts";

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
    Layer.provideMerge(utils()),
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
    DynamoDB.TableProvider(),
    EC2.EgressOnlyInternetGatewayProvider(),
    EC2.EIPProvider(),
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
    Kinesis.StreamProvider(),
    Lambda.EventSourceMappingProvider(),
    Lambda.FunctionProvider(),
    Lambda.PermissionProvider(),
    S3.BucketProvider(),
    SNS.SubscriptionProvider(),
    SNS.TopicProvider(),
    SQS.QueueProvider(),
  );

/**
 * All AWS binding policies.
 *
 * These layers attach IAM statements and event-source bindings to functions at
 * deploy time so runtime bindings like `PutObject.bind(bucket)` can execute
 * with the required permissions.
 */
export const bindings = () =>
  Layer.mergeAll(
    DynamoDB.DeleteItemPolicyLive,
    DynamoDB.DescribeTablePolicyLive,
    DynamoDB.DescribeTimeToLivePolicyLive,
    DynamoDB.ExecuteTransactionPolicyLive,
    DynamoDB.GetItemPolicyLive,
    DynamoDB.ListTablesPolicyLive,
    DynamoDB.ListTagsOfResourcePolicyLive,
    DynamoDB.PutItemPolicyLive,
    DynamoDB.QueryPolicyLive,
    DynamoDB.RestoreTableToPointInTimePolicyLive,
    DynamoDB.ScanPolicyLive,
    DynamoDB.UpdateItemPolicyLive,
    DynamoDB.UpdateTimeToLivePolicyLive,
    Kinesis.PutRecordPolicyLive,
    Kinesis.PutRecordsPolicyLive,
    Lambda.BucketEventSourcePolicyLive,
    Lambda.QueueEventSourcePolicyLive,
    Lambda.TableEventSourcePolicyLive,
    Lambda.TopicEventSourcePolicyLive,
    S3.AbortMultipartUploadPolicyLive,
    S3.CompleteMultipartUploadPolicyLive,
    S3.CreateMultipartUploadPolicyLive,
    S3.DeleteObjectPolicyLive,
    S3.GetObjectPolicyLive,
    S3.HeadObjectPolicyLive,
    S3.ListObjectsV2PolicyLive,
    S3.PutObjectPolicyLive,
    S3.UploadPartPolicyLive,
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
    SQS.DeleteMessageBatchPolicyLive,
    SQS.QueueSinkPolicyLive,
    SQS.SendMessageBatchPolicyLive,
    SQS.SendMessagePolicyLive,
    // SQS.QueueEventSourcePolicyLive,
  );

const utils = () => rolldown();
