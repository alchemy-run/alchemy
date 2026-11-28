import * as AWS from "@alchemy.run/aws";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Schedule from "effect/Schedule";
import { awsApp, AwsGateway } from "../conformance/aws-app.ts";

/**
 * Private subnets behind one NAT gateway: the host Lambda calls the ECS API
 * from inside the VPC, ECS instances pull the sandbox image, and the sandbox
 * reaches its gateway.
 */
export const GatewayNetwork = AWS.EC2.Network("GatewayEcsNetwork", {
  cidrBlock: "10.68.0.0/16",
  nat: "single",
});

export const GatewayCluster = AWS.ECS.Cluster("GatewayEcsCluster", {});

export const GatewayCapacity = Effect.gen(function* () {
  const cluster = yield* GatewayCluster;
  const network = yield* GatewayNetwork;
  return yield* AWS.ECS.CapacityProvider("GatewayEcsCapacity", {
    cluster: cluster.clusterName,
    managedInstancesProvider: {
      instanceLaunchTemplate: {
        networkConfiguration: { subnets: network.privateSubnetIds },
        nitroEnclavesEnabled: true,
      },
    },
  });
});

/** The AWS conformance program as an ECS task in its own Nitro Sandbox. */
export class GatewayedEcs extends AWS.ECS.Task<GatewayedEcs>()(
  "GatewayedEcs",
  {
    main: import.meta.filename,
    handler: "GatewayedEcs",
    // Docker Hub's `oven/bun` image; the public.ecr.aws default mirror
    // rate-limits anonymous pulls (429) during local builds.
    image: "oven/bun:1",
    port: 3000,
    cpu: 1024,
    memory: 2048,
    isolation: "isolated",
  },
  awsApp.pipe(Effect.provide(AwsGateway)),
) {}

/** Starts a sandbox of the program per request and returns its answer. */
export default class EcsHost extends AWS.Lambda.Function<EcsHost>()(
  "GatewayEcsHost",
  {
    main: import.meta.filename,
    functionUrl: true,
    // The first sandbox waits for ECS to launch an instance.
    timeout: Duration.seconds(285),
    memorySize: 512,
  },
  Effect.gen(function* () {
    const capacity = yield* GatewayCapacity;
    const sandboxes = yield* AWS.ECS.CreateSandbox(capacity, GatewayedEcs);
    return {
      fetch: Effect.gen(function* () {
        const sandbox = yield* sandboxes.create({ startTimeout: "4 minutes" });
        const answer = yield* Effect.gen(function* () {
          const port = yield* sandbox.getTcpPort(3000);
          const response = yield* port
            .fetch(HttpClientRequest.get("/"))
            .pipe(Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 10 }));
          return { status: response.status, text: yield* response.text };
        }).pipe(Effect.ensuring(Effect.ignore(sandbox.kill())));
        return HttpServerResponse.text(answer.text, {
          status: answer.status,
          headers: { "content-type": "application/json" },
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(String(cause), { status: 500 })),
        ),
      ),
    };
  }).pipe(Effect.provide(AWS.ECS.CreateSandboxHttp)),
) {}
