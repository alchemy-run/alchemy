import { Providers as AwsProviders } from "@/AWS/Providers.ts";
import * as AWS from "@/AWS/index.ts";
import * as Celld from "@/Celld/index.ts";
import * as Test from "@/Test/Alchemy.ts";
import { composeEcsFleet } from "@/Celld/EcsFleet.ts";
import { Host } from "@/Celld/Host.ts";
import { FleetManagement } from "@/Celld/Management.ts";
import {
  ec2NodeTaskConfiguration,
  makeEc2UserData,
  resolveEc2NodeSizing,
} from "@/Celld/EcsEc2.ts";
import { Providers as CelldProviders } from "@/Celld/Providers.ts";
import * as Output from "@/Output.ts";
import { Stack } from "@/Stack.ts";
import { Stage } from "@/Stage.ts";
import { inMemoryState } from "@/State/InMemoryState.ts";
import type * as ec2 from "@distilled.cloud/aws/ec2";
import { Region } from "@distilled.cloud/aws/Region";
import { Credentials } from "@distilled.cloud/aws/Credentials";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { makeEcsDockerfile } from "@/Celld/EcsHostConfig.ts";
import { DEFAULT_CELLD_IMAGE } from "@/Celld/CelldCli.ts";

const providers = Layer.mergeAll(
  AWS.providers(),
  Celld.providers(),
  Celld.EcsFleet(),
);
const { test } = Test.make({ providers });

const instance: ec2.InstanceTypeInfo = {
  InstanceType: "m7i.large",
  ProcessorInfo: { SupportedArchitectures: ["x86_64"] },
  SupportedVirtualizationTypes: ["hvm"],
  MemoryInfo: { SizeInMiB: 8192 },
  VCpuInfo: { DefaultVCpus: 2 },
};
const environment = () =>
  Layer.mergeAll(
    inMemoryState(),
    Layer.succeed(AwsProviders, {
      kind: "ProviderCollection",
      get: () => undefined,
      providers: {},
    }),
    Layer.succeed(CelldProviders, {
      kind: "ProviderCollection",
      get: () => undefined,
      providers: {},
    }),
    Layer.succeed(Region, Effect.succeed("us-east-1")),
    Layer.succeed(Stage, "test"),
    Layer.succeed(Stack, {
      name: "ecs-host-composition",
      stage: "test",
      resources: {},
      bindings: {},
      actions: {},
    }),
  );
const vpc = {
  vpcId: "vpc-test",
  subnetIds: ["subnet-a", "subnet-b"],
  securityGroupIds: ["sg-existing-callers"],
};

test(
  "merged provider DX exposes both Host and IAM FleetManagement",
  Effect.gen(function* () {
    expect(typeof (yield* Host).compose).toBe("function");
    expect(typeof (yield* FleetManagement).activate).toBe("function");
  }).pipe(Effect.provide(providers.pipe(Layer.provide(environment())))),
);

describe("Celld ECS composition", () => {
  it.effect(
    "generated host and task shell fixtures parse without executing infrastructure commands",
    () =>
      Effect.gen(function* () {
        const sizing = yield* resolveEc2NodeSizing(instance, {});
        const hostScript = makeEc2UserData(
          "celld-test",
          "us-east-1",
          sizing,
          "runsc",
        );
        const host = yield* ChildProcess.make(
          "bash",
          ["-n", "-c", hostScript],
          { stdout: "ignore", stderr: "inherit" },
        );
        expect(yield* host.exitCode).toBe(0);
        for (const capacity of ["ec2", "fargate"] as const) {
          const script = makeEcsDockerfile(DEFAULT_CELLD_IMAGE, capacity)
            .split("COPY <<'ENTRYPOINT_EOF' /alchemy/entrypoint.sh\n")[1]!
            .split("\nENTRYPOINT_EOF")[0]!;
          const task = yield* ChildProcess.make("sh", ["-n", "-c", script], {
            stdout: "ignore",
            stderr: "inherit",
          });
          expect(yield* task.exitCode).toBe(0);
        }
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  for (const capacity of ["ec2", "fargate"] as const) {
    it.effect(
      `composes ${capacity} bootstrap, security, and scheduling dependencies`,
      () =>
        Effect.gen(function* () {
          const stack = yield* Stack;
          const host = yield* composeEcsFleet(
            Effect.succeed("us-east-1"),
            capacity === "ec2"
              ? {
                  capacity: { type: "ec2", instanceType: "m7i.large" },
                  containerRuntime: "runsc",
                }
              : {},
            () => Effect.succeed(instance),
            () =>
              Effect.succeed({
                routeTables: [
                  {
                    RouteTableId: "rtb-public",
                    Associations: [{ Main: true }],
                    Routes: [
                      {
                        DestinationCidrBlock: "0.0.0.0/0",
                        GatewayId: "igw-public",
                        State: "active",
                      },
                    ],
                  },
                ],
                endpoints:
                  capacity === "ec2"
                    ? [
                        {
                          VpcEndpointId: "vpce-owned",
                          VpcEndpointType: "Gateway",
                          State: "available",
                          RouteTableIds: ["rtb-public"],
                          Tags: [
                            {
                              Key: "alchemy::stack",
                              Value: "ecs-host-composition",
                            },
                            { Key: "alchemy::stage", Value: "test" },
                            {
                              Key: "alchemy::id",
                              Value: "ManagementS3Endpoint",
                            },
                            {
                              Key: "celld:management",
                              Value: "Cells/ManagementS3Endpoint",
                            },
                          ],
                        },
                      ]
                    : [],
              }),
          )({ id: "Cells", props: { vpc } });
          const resources = stack.resources;
          const nodes = resources["Cells/Nodes"]!;
          expect(resources["Cells/Bucket"]!.RemovalPolicy).toBe("retain");
          expect(resources["Cells/Bucket"]!.Props.forceDestroy).toBeUndefined();
          expect(
            Output.resolveUpstream(nodes.Props.env.CELLD_BOOTSTRAP_VERSION)[
              "Cells/Bootstrap"
            ],
          ).toBe(resources["Cells/Bootstrap"]);
          expect(nodes.Props.env.AWS_ACCESS_KEY_ID).toBeUndefined();
          const management = resources["Cells/Management"]!;
          expect(management.Props.functionUrl).toBe(false);
          expect(management.Props.env.CELLD_MANAGEMENT_MINIMUM_NODES).toBe("2");
          expect(
            Output.resolveUpstream(
              management.Props.env.CELLD_MANAGEMENT_BUCKET,
            )["Cells/Bucket"],
          ).toBe(resources["Cells/Bucket"]);
          expect(
            Object.keys(
              Output.resolveUpstream(management.Props.vpc.securityGroupIds),
            ),
          ).toEqual(["Cells/ManagementSecurityGroup"]);
          expect(
            Object.keys(Output.resolveUpstream(management.Props.vpc.subnetIds)),
          ).toEqual(["Cells/ManagementS3Endpoint"]);
          expect(
            resources["Cells/ManagementS3Endpoint"]!.Props.routeTableIds,
          ).toEqual(["rtb-public"]);
          expect(
            resources["Cells/ManagementS3Endpoint"]!.Props.serviceName,
          ).toBe("com.amazonaws.us-east-1.s3");
          expect(
            Output.resolveUpstream(host.hostState?.managementFunctionArn)[
              "Cells/Management"
            ],
          ).toBe(management);
          expect(host.hostState?.peerAuth).toBeUndefined();
          const statements = stack.bindings["Cells/Management"]!.flatMap(
            (binding) => binding.data.policyStatements ?? [],
          );
          expect(statements.map((statement) => statement.Action)).toEqual([
            ["s3:GetObject"],
            ["s3:ListBucket"],
          ]);
          expect(statements[1]!.Condition).toEqual({
            StringLike: { "s3:prefix": ["nodes/"] },
          });
          expect(host.hostState?.capabilities).toEqual({
            containers: capacity === "ec2",
            sandbox: capacity === "ec2",
          });
          expect(
            Output.resolveUpstream(host.hostState?.securityGroupIds)[
              "Cells/CallerSecurityGroup"
            ],
          ).toBe(resources["Cells/CallerSecurityGroup"]);
          expect(
            Output.resolveUpstream(host.hostState?.managementSecurityGroupIds)[
              "Cells/ManagementSecurityGroup"
            ],
          ).toBe(resources["Cells/ManagementSecurityGroup"]);
          if (capacity === "ec2") {
            expect(nodes.Props.launchType).toBeUndefined();
            expect(nodes.Props.capacityProviderStrategy).toHaveLength(1);
            expect(nodes.Props.networkMode).toBe("host");
            expect(nodes.Props.placementConstraints).toContainEqual({
              type: "distinctInstance",
            });
            expect(nodes.Props.runtimePlatform.cpuArchitecture).toBe("X86_64");
            expect(nodes.Props.cpu).toBe(1792);
            expect(nodes.Props.memory).toBe(6912);
            expect(nodes.Props.loadBalancers).toHaveLength(2);
            expect(nodes.Props.container.portMappings).toEqual([
              { containerPort: 8080, hostPort: 8080, protocol: "tcp" },
              { containerPort: 8081, hostPort: 8081, protocol: "tcp" },
            ]);
            expect(resources["Cells/Hosts"]!.Props.desiredCapacity).toBe(3);
            expect(resources["Cells/Capacity"]!.Props.managedDraining).toBe(
              "ENABLED",
            );
            expect(resources["Cells/PrivateIngress"]!.Props.scheme).toBe(
              "internal",
            );
            expect(resources["Cells/PrivateTarget8080"]!.Props.targetType).toBe(
              "instance",
            );
            expect(resources["Cells/PrivateTarget8081"]!.Props.targetType).toBe(
              "instance",
            );
            expect(resources["Cells/FleetRecord"]).toBeUndefined();
            expect(
              Object.keys(Output.resolveUpstream(host.fleetUrl)),
            ).toContain("Cells/PrivateIngress");
          } else {
            expect(nodes.Props.launchType).toBe("FARGATE");
            expect(nodes.Props.capacityProviderStrategy).toBeUndefined();
            expect(nodes.Props.networkMode).toBe("awsvpc");
            expect(nodes.Props.runtimePlatform.cpuArchitecture).toBe("ARM64");
            expect(nodes.Props.volumes).toBeUndefined();
            expect(nodes.Props.container.mountPoints).toBeUndefined();
            expect(resources["Cells/Hosts"]).toBeUndefined();
            expect(resources["Cells/FleetRecord"]!.Props.dnsRecords).toEqual([
              { type: "A", ttl: "10 seconds" },
            ]);
          }
        }).pipe(Effect.provide(environment())),
    );
  }

  it.effect(
    "places the default management runner on private subnets after their S3 endpoint and associations",
    () =>
      Effect.gen(function* () {
        const stack = yield* Stack;
        yield* composeEcsFleet(
          Effect.succeed("us-east-1"),
          {},
          () => Effect.succeed(instance),
          () =>
            Effect.die("Generated networks must not inspect existing routes"),
        )({ id: "Cells", props: {} });
        const resources = stack.resources;
        const runner = resources["Cells/Management"]!;
        const dependencies = Object.keys(
          Output.resolveUpstream(runner.Props.vpc.subnetIds),
        );
        expect(dependencies).toContain("Cells/Network/S3Endpoint");
        expect(dependencies).toContain("Cells/Network/PrivateSubnet1");
        expect(dependencies).toContain(
          "Cells/Network/PrivateSubnetAssociation1",
        );
        expect(dependencies).not.toContain("Cells/Network/PublicSubnet1");
        expect(
          Object.keys(
            Output.resolveUpstream(
              resources["Cells/Network/S3Endpoint"]!.Props.routeTableIds,
            ),
          ),
        ).toEqual(["Cells/Network/PrivateRouteTable"]);
        expect(
          Object.keys(
            Output.resolveUpstream(resources["Cells/Nodes"]!.Props.subnets),
          ),
        ).toContain("Cells/Network/PublicSubnet1");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            environment(),
            Layer.succeed(
              Credentials,
              Effect.succeed({
                accessKeyId: Redacted.make("test"),
                secretAccessKey: Redacted.make("test"),
                sessionToken: undefined,
                region: "us-east-1",
              }),
            ),
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make((request) =>
                Effect.sync(() => {
                  expect(request.method).toBe("POST");
                  return HttpClientResponse.fromWeb(
                    request,
                    new Response(
                      '<DescribeAvailabilityZonesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/"><availabilityZoneInfo><item><zoneName>us-east-1a</zoneName><zoneState>available</zoneState></item><item><zoneName>us-east-1b</zoneName><zoneState>available</zoneState></item></availabilityZoneInfo></DescribeAvailabilityZonesResponse>',
                      { headers: { "content-type": "text/xml" } },
                    ),
                  );
                }),
              ),
            ),
          ),
        ),
      ),
  );

  it.effect(
    "sizes child-container reservations against whole-host capacity with OS headroom",
    () =>
      Effect.gen(function* () {
        const sizing = yield* resolveEc2NodeSizing(instance, {});
        expect(sizing).toEqual({
          architecture: "X86_64",
          hostMemoryMiB: 8192,
          hostCpuUnits: 2048,
          reservedMemoryMiB: 1024,
          kernelReserveMiB: 256,
          memoryMiB: 6912,
          cpuUnits: 1792,
          nodes: 2,
        });
        const arm = yield* resolveEc2NodeSizing(
          { ...instance, ProcessorInfo: { SupportedArchitectures: ["arm64"] } },
          {},
        );
        expect(arm.architecture).toBe("ARM64");
        for (const props of [
          { cpuArchitecture: "ARM64" as const },
          { memory: 8192 },
          { cpu: 2048 },
          { instances: { min: 1, max: 3 } },
        ]) {
          expect(
            Result.isFailure(
              yield* Effect.result(resolveEc2NodeSizing(instance, props)),
            ),
          ).toBe(true);
        }
        expect(
          Result.isFailure(
            yield* Effect.result(resolveEc2NodeSizing(undefined, {})),
          ),
        ).toBe(true);
      }),
  );

  it.effect(
    "bootstraps runsc without making it the Docker default and gates ECS registration",
    () =>
      Effect.gen(function* () {
        const sizing = yield* resolveEc2NodeSizing(instance, {});
        const script = makeEc2UserData(
          "celld-test",
          "us-east-1",
          sizing,
          "runsc",
        );
        expect(script).toContain("dnf install -y jq\n");
        expect(script).toContain(
          "command -v curl >/dev/null || dnf install -y curl-minimal",
        );
        expect(script).not.toContain("dnf install -y jq curl");
        expect(script).toContain("sha512sum -c runsc.sha512");
        expect(script).toContain(".runtimes.runsc");
        expect(script).not.toContain("default-runtime");
        expect(script).toContain("ECS_ENABLE_TASK_IAM_ROLE_NETWORK_HOST=true");
        expect(script).toContain(
          "ConditionPathExists=/var/lib/celld-host/ready",
        );
        expect(script).toContain("DescribeClusters");
        expect(script).toContain(
          'capacityProviders | index("celld-test-capacity") != null',
        );
        expect(script).toContain("Restart=on-failure");
        expect(script).toContain("RestartSec=10");
        expect(script).toContain("StartLimitIntervalSec=0");
        expect(script).toContain(
          "ExecStart=/usr/local/sbin/celld-host-register",
        );
        const register = script
          .split("<<'REGISTER'\n")[1]!
          .split("\nREGISTER\n")[0]!;
        expect(register).toContain("latest/api/token");
        expect(register).toContain("iam/security-credentials/");
        expect(register).toContain("for attempt in 1 2 3 4 5 6 7 8");
        expect(script.indexOf("touch /var/lib/celld-host/ready")).toBeLessThan(
          script.indexOf("systemctl enable --now --no-block ecs"),
        );
        expect(script).toContain("docker stop -t 120");
        expect(script).toContain("--filter label=celld.node");
        expect(script).not.toContain("celld deploy");
        const task = ec2NodeTaskConfiguration("runsc");
        expect(task.container.privileged).toBe(false);
        expect(task.container.linuxParameters.capabilities.drop).toEqual([
          "ALL",
        ]);
        expect(task.container.mountPoints).toContainEqual({
          sourceVolume: "scratch",
          containerPath: "/var/lib/celld",
          readOnly: false,
        });
        expect(task.volumes).toContainEqual({
          name: "scratch",
          host: { sourcePath: "/var/lib/celld" },
        });
        expect(task.env.CELLD_CONTAINER_RUNTIME).toBe("runsc");
      }),
  );
});
