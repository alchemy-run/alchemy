import * as AWS from "@alchemy.run/aws";
import * as Boat from "@alchemy.run/boat";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { awsApp } from "../conformance/aws-app.ts";

export const GatewayServiceCluster = AWS.ECS.Cluster("GatewayServiceCluster", {});

/**
 * The AWS conformance program in a Boat sandbox, with an ECS Service
 * gateway: a Fargate task in the default VPC, behind its own load balancer.
 */
export default class EcsGatewayedBoat extends Boat.Sandbox<EcsGatewayedBoat>()(
  "EcsGatewayedBoat",
  { main: import.meta.url, type: "small", noEnv: true },
  awsApp.pipe(
    Effect.provide(
      Layer.mergeAll(AWS.S3.PutObjectHttp, AWS.S3.GetObjectHttp, AWS.S3.PresignGetObjectHttp).pipe(
        Layer.provide(
          AWS.ECS.SandboxGateway(
            GatewayServiceCluster.pipe(
              Effect.map((cluster) => ({
                cluster,
                port: 3000,
                cpu: 256,
                memory: 512,
                desiredCount: 1,
                loadBalancer: true,
              })),
            ),
          ),
        ),
      ),
    ),
  ),
) {}
