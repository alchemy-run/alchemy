import * as AWS from "@/AWS";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";
import { getDefaultVpc } from "../DefaultVpc.ts";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class CloudMapTestFunction extends AWS.Lambda.Function<AWS.Lambda.Function>()(
  "CloudMapTestFunction",
) {}

/**
 * Resolve the default VPC for the fixture's private DNS namespace.
 *
 * Runtime-guarded: the Lambda runtime re-executes this props effect on cold
 * start, but the namespace's VPC association is deploy-time-only
 * configuration and the execution role has no ec2:Describe* permissions —
 * return a placeholder there without touching the EC2 API.
 */
const resolveFixtureVpc = Effect.gen(function* () {
  if (globalThis.__ALCHEMY_RUNTIME__) {
    return "vpc-unused-at-runtime";
  }
  // Deploy-time only: a missing default VPC is an unrecoverable fixture
  // setup failure, so orDie rather than leak EC2's error channel into the
  // Function program (whose error channel must stay ConfigError).
  return (yield* getDefaultVpc.pipe(Effect.orDie)).vpcId as string;
});

export default CloudMapTestFunction.make(
  {
    main,
    url: true,
    // several routes fan out Cloud Map API calls; the 3s default is too tight
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const vpc = yield* resolveFixtureVpc;
    const namespace = yield* AWS.CloudMap.PrivateDnsNamespace(
      "FixtureNamespace",
      {
        name: "alchemy-cloudmap-fixture.local",
        vpc,
      },
    );
    const service = yield* AWS.CloudMap.Service("FixtureService", {
      namespaceId: namespace.namespaceId,
      name: "backend",
      dnsRecords: [{ type: "A", ttl: 10 }],
      routingPolicy: "MULTIVALUE",
    });

    const discoverInstances = yield* AWS.CloudMap.DiscoverInstances(service);
    const registerInstance = yield* AWS.CloudMap.RegisterInstance(service);
    const deregisterInstance = yield* AWS.CloudMap.DeregisterInstance(service);
    const ServiceId = yield* service.serviceId;
    const NamespaceName = yield* service.namespaceName;
    const ServiceName = yield* service.serviceName;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/info") {
          const serviceId = yield* ServiceId;
          const namespaceName = yield* NamespaceName;
          const serviceName = yield* ServiceName;
          return yield* HttpServerResponse.json({
            serviceId,
            namespaceName,
            serviceName,
          });
        }

        if (request.method === "GET" && pathname === "/discover") {
          const health = url.searchParams.get("health") ?? "ALL";
          const result = yield* discoverInstances({
            HealthStatus: health as "HEALTHY" | "UNHEALTHY" | "ALL",
          });
          return yield* HttpServerResponse.json({
            instances: (result.Instances ?? []).map((instance) => ({
              instanceId: instance.InstanceId,
              healthStatus: instance.HealthStatus,
              attributes: instance.Attributes ?? {},
            })),
          });
        }

        if (request.method === "POST" && pathname === "/register") {
          const body = (yield* request.json) as unknown as {
            instanceId: string;
            attributes: Record<string, string>;
          };
          const result = yield* registerInstance({
            InstanceId: body.instanceId,
            Attributes: body.attributes,
          });
          return yield* HttpServerResponse.json({
            operationId: result.OperationId,
          });
        }

        if (request.method === "POST" && pathname === "/deregister") {
          const body = (yield* request.json) as unknown as {
            instanceId: string;
          };
          const result = yield* deregisterInstance({
            InstanceId: body.instanceId,
          });
          return yield* HttpServerResponse.json({
            operationId: result.OperationId,
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found" },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        AWS.CloudMap.DiscoverInstancesHttp,
        AWS.CloudMap.RegisterInstanceHttp,
        AWS.CloudMap.DeregisterInstanceHttp,
      ),
    ),
  ),
);
