/**
 * The management runner as a VPC Lambda, invoked synchronously over IAM.
 * Calls never wait for a runner to start, but AWS releases a VPC Lambda's
 * network interfaces slowly, so destroying the fleet takes around 20 minutes.
 */
import * as EC2 from "@alchemy.run/aws/EC2";
import { Credentials } from "@distilled.cloud/aws/Credentials";
import * as ec2 from "@distilled.cloud/aws/ec2";
import * as LambdaSdk from "@distilled.cloud/aws/lambda";
import { Retry } from "@distilled.cloud/aws/Retry";
import { toFqn } from "alchemy/FQN";
import type { Input } from "alchemy/Input";
import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import { Stack, type StackServices } from "alchemy/Stack";
import { isActionState, State } from "alchemy/State/State";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { FleetManagementError } from "../Management.ts";
import { ecsAwsEnvironment } from "./EcsEnvironment.ts";
import { EcsHostConfigurationError, resolveManagementRouteTables } from "./EcsHostConfig.ts";
import {
  EcsManagement,
  type EcsManagementFleet,
  type EcsManagementService,
} from "./EcsManagement.ts";
import { ManagementLambda } from "./ManagementLambda.ts";
import { makeManagementClient, type ManagementTransport } from "./ManagementRunner.ts";

/** The route tables and S3 gateway endpoints of a caller's VPC. */
export type DescribeManagementNetwork = (
  vpcId: string,
  region: string,
) => Effect.Effect<
  { routeTables: ec2.RouteTable[]; endpoints: ec2.VpcEndpoint[] },
  ec2.DescribeRouteTablesError | ec2.DescribeVpcEndpointsError | EcsHostConfigurationError
>;

/**
 * Subnets for the runner with a private route to the fleet bucket: in a
 * caller's VPC, an S3 gateway endpoint on the subnets' route tables (unless
 * they already have one); in the fleet's own network, its private subnets.
 */
const managementSubnets = Effect.fn(function* (
  fleet: EcsManagementFleet,
  describeManagementNetwork: DescribeManagementNetwork,
) {
  if (fleet.vpc === undefined) {
    const network = fleet.network!;
    return network.privateSubnets.map((subnet, index) =>
      Output.all(
        subnet.subnetId,
        network.privateRouteAssociations[index]!.associationId,
        network.gatewayEndpoints[0]!.vpcEndpointId,
      ).pipe(Output.map(([subnetId]) => subnetId)),
    ) as Input<EC2.SubnetId[]>;
  }
  const vpc = fleet.vpc;
  const stack = yield* Stack;
  const state = yield* yield* State;
  const observed = yield* describeManagementNetwork(vpc.vpcId, fleet.region);
  const endpointFqn = toFqn(yield* Namespace.CurrentNamespace, "ManagementS3Endpoint");
  const persistedEndpoint = yield* state.get({
    stack: stack.name,
    stage: stack.stage,
    fqn: endpointFqn,
  });
  const persistedEndpointId =
    persistedEndpoint && !isActionState(persistedEndpoint)
      ? persistedEndpoint.attr?.vpcEndpointId
      : undefined;
  const routeTableIds = yield* resolveManagementRouteTables({
    subnetIds: vpc.subnetIds,
    ...observed,
    ownedEndpointIds: observed.endpoints
      .filter((endpoint) => {
        const tags = Object.fromEntries((endpoint.Tags ?? []).map((tag) => [tag.Key, tag.Value]));
        return (
          endpoint.VpcEndpointId === persistedEndpointId ||
          (tags["alchemy::stack"] === stack.name &&
            tags["alchemy::stage"] === stack.stage &&
            tags["alchemy::id"] === "ManagementS3Endpoint" &&
            tags["celld:management"] === endpointFqn)
        );
      })
      .flatMap((endpoint) => (endpoint.VpcEndpointId ? [endpoint.VpcEndpointId] : [])),
  });
  if (routeTableIds.length === 0) return vpc.subnetIds as EC2.SubnetId[];
  const endpoint = yield* EC2.VpcEndpoint("ManagementS3Endpoint", {
    vpcId: fleet.vpcId,
    serviceName: `com.amazonaws.${fleet.region}.s3`,
    vpcEndpointType: "Gateway",
    routeTableIds,
    tags: { ...fleet.tags, "celld:management": endpointFqn },
  });
  return endpoint.vpcEndpointId.pipe(Output.map(() => vpc.subnetIds as EC2.SubnetId[])) as Input<
    EC2.SubnetId[]
  >;
});

/** The Lambda runner over a given view of the caller's network and an invocation transport. */
export const makeEcsLambdaManagement = (
  describeManagementNetwork: DescribeManagementNetwork,
  transport: ManagementTransport,
): EcsManagementService => ({
  compose: Effect.fn(function* (fleet) {
    const managementSubnetIds = yield* managementSubnets(fleet, describeManagementNetwork);
    const runner = yield* ManagementLambda("Management", {
      bucketName: fleet.bucketName,
      minimumNodes: fleet.minimumNodes,
      partition: fleet.partition,
      vpc: {
        subnetIds: managementSubnetIds,
        securityGroupIds: [fleet.securityGroupId],
      },
    });
    return { managementSubnetIds, managementFunctionArn: runner.functionArn };
  }),
  client: makeManagementClient(() => Effect.succeed(transport)),
});

/** Synchronous IAM invocation of the fleet's private runner Lambda; no automatic retries. */
export const makeLambdaTransport = Effect.gen(function* () {
  const credentials = yield* Credentials;
  const http = yield* HttpClient.HttpClient;
  const services = Layer.mergeAll(
    Layer.succeed(Credentials, credentials),
    Layer.succeed(HttpClient.HttpClient, http),
    Layer.succeed(Retry, { while: () => false }),
  );
  const transport: ManagementTransport = (connection, payload) =>
    Effect.gen(function* () {
      const functionArn = connection.hostState?.managementFunctionArn;
      if (
        typeof functionArn !== "string" ||
        !/^arn:aws(?:-us-gov|-cn)?:lambda:[a-z0-9-]+:\d{12}:function:[a-zA-Z0-9-_]+(?::[a-zA-Z0-9$_-]+)?$/.test(
          functionArn,
        )
      )
        return yield* new FleetManagementError({
          reason: "configuration",
          message: "Fleet hostState must include an IAM managementFunctionArn and backing bucket.",
        });
      const response = yield* LambdaSdk.invoke({
        FunctionName: functionArn,
        InvocationType: "RequestResponse",
        LogType: "None",
        Payload: payload,
      }).pipe(
        Effect.provide(services),
        Effect.mapError(
          () =>
            new FleetManagementError({
              reason: "transport",
              message:
                "IAM Celld management invocation failed; do not retry an ambiguous mutation.",
            }),
        ),
      );
      if (response.StatusCode !== 200 || response.FunctionError || !response.Payload)
        return yield* new FleetManagementError({
          reason: "transport",
          message:
            "Celld management runner did not return a successful synchronous response; mutation outcome may be ambiguous.",
        });
      const chunks = yield* Stream.runCollect(response.Payload).pipe(
        Effect.mapError(
          () =>
            new FleetManagementError({
              reason: "transport",
              message:
                "Celld management response was interrupted; mutation outcome may be ambiguous.",
            }),
        ),
      );
      return yield* Effect.sync(
        () => new Uint8Array(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))),
      );
    }).pipe(
      Effect.timeoutOrElse({
        duration: "85 seconds",
        orElse: () =>
          Effect.fail(
            new FleetManagementError({
              reason: "transport",
              message: "Celld management invocation timed out; mutation outcome may be ambiguous.",
            }),
          ),
      }),
    );
  return transport;
});

const collectNetworkPages = <A, E>(
  fetch: (token: string | undefined) => Effect.Effect<{ items: A[]; nextToken?: string }, E>,
) =>
  Effect.gen(function* () {
    const items: A[] = [];
    let token: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = yield* fetch(token);
      items.push(...result.items);
      token = result.nextToken;
      if (!token) return items;
    }
    return yield* new EcsHostConfigurationError({
      message:
        "Management network discovery exceeded ten pages; refusing an incomplete S3 route inventory.",
    });
  });

/**
 * Host an {@link EcsFleet}'s management runner as a VPC Lambda, invoked
 * synchronously over IAM. It costs nothing between deploys and calls only wait
 * for a Lambda cold start, but AWS releases a VPC Lambda's network interfaces
 * slowly, so destroying the fleet takes around 20 minutes.
 *
 * In a caller's VPC the runner needs a private route to the fleet bucket:
 * the fleet adds an S3 gateway endpoint to the subnets' route tables unless
 * they already have one.
 *
 * ### Hosting the Runner
 * **Example:** Run management as a VPC Lambda
 * ```typescript
 * const host = CelldAWS.EcsFleet().pipe(Layer.provide(CelldAWS.EcsLambdaManagement()));
 * ```
 *
 * @layer
 * @provides CelldAWS.EcsManagement
 * @product Celld
 */
export const EcsLambdaManagement = (): Layer.Layer<EcsManagement, never, StackServices> =>
  Layer.effect(
    EcsManagement,
    Effect.gen(function* () {
      const describeRouteTables = yield* ec2.describeRouteTables;
      const describeVpcEndpoints = yield* ec2.describeVpcEndpoints;
      return makeEcsLambdaManagement(
        (vpcId, regionName) =>
          Effect.all({
            routeTables: collectNetworkPages((NextToken) =>
              describeRouteTables({
                Filters: [{ Name: "vpc-id", Values: [vpcId] }],
                NextToken,
              }).pipe(
                Effect.map((response) => ({
                  items: response.RouteTables ?? [],
                  nextToken: response.NextToken,
                })),
              ),
            ),
            endpoints: collectNetworkPages((NextToken) =>
              describeVpcEndpoints({
                Filters: [
                  { Name: "vpc-id", Values: [vpcId] },
                  { Name: "service-name", Values: [`com.amazonaws.${regionName}.s3`] },
                ],
                NextToken,
              }).pipe(
                Effect.map((response) => ({
                  items: response.VpcEndpoints ?? [],
                  nextToken: response.NextToken,
                })),
              ),
            ),
          }),
        yield* makeLambdaTransport,
      );
    }),
  ).pipe(Layer.provide(Layer.mergeAll(ecsAwsEnvironment, FetchHttpClient.layer)), Layer.orDie);
