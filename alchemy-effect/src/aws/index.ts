import * as Layer from "effect/Layer";
import * as ESBuild from "../esbuild.ts";
import * as Account from "./account.ts";
import * as Credentials from "./credentials.ts";
import * as DynamoDB from "./dynamodb/index.ts";
import * as EC2 from "./ec2/index.ts";
import * as Endpoint from "./endpoint.ts";
import * as Kinesis from "./kinesis/index.ts";
import * as Lambda from "./lambda/index.ts";
import * as Region from "./region.ts";
import * as S3 from "./s3/index.ts";
import * as SQS from "./sqs/index.ts";

import "./config.ts";

export const resources = () =>
  Layer.mergeAll(
    DynamoDB.tableProvider(),
    EC2.egressOnlyInternetGatewayProvider(),
    EC2.eipProvider(),
    EC2.internetGatewayProvider(),
    EC2.natGatewayProvider(),
    EC2.networkAclAssociationProvider(),
    EC2.networkAclEntryProvider(),
    EC2.networkAclProvider(),
    EC2.routeProvider(),
    EC2.routeTableAssociationProvider(),
    EC2.routeTableProvider(),
    EC2.securityGroupProvider(),
    EC2.securityGroupRuleProvider(),
    EC2.subnetProvider(),
    EC2.vpcEndpointProvider(),
    EC2.vpcProvider(),
    Kinesis.streamProvider(),
    Lambda.functionProvider(),
    S3.bucketPolicyProvider(),
    S3.bucketProvider(),
    SQS.queueProvider(),
  );

export const bindings = () =>
  Layer.mergeAll(
    DynamoDB.getItemFromLambdaFunction(),
    Kinesis.streamEventSourceProvider(),
    Kinesis.putRecordFromLambdaFunction(),
    S3.bucketEventSourceProvider(),
    S3.deleteObjectFromLambdaFunction(),
    S3.getObjectFromLambdaFunction(),
    S3.putObjectFromLambdaFunction(),
    SQS.queueEventSourceProvider(),
    SQS.sendMessageFromLambdaFunction(),
  );

export const utils = () => Layer.mergeAll(ESBuild.layer());

export const bareProviders = () =>
  resources().pipe(Layer.provideMerge(bindings()), Layer.provideMerge(utils()));

export const config = <L extends Layer.Layer<any, any, any>>(layer: L) =>
  layer.pipe(
    Layer.provideMerge(Account.fromStageConfig()),
    Layer.provideMerge(Region.fromStageConfig()),
    Layer.provideMerge(Credentials.fromStageConfig()),
    Layer.provideMerge(Endpoint.fromStageConfig()),
  );

export const providers = () =>
  bareProviders().pipe(
    Layer.provideMerge(Account.fromStageConfig()),
    Layer.provideMerge(Region.fromStageConfig()),
    Layer.provideMerge(Credentials.fromStageConfig()),
    Layer.provideMerge(Endpoint.fromStageConfig()),
  );
