import { DEFAULT_CELLD_IMAGE, DEFAULT_CELLD_VERSION } from "@/Celld/CelldCli";
import {
  EcsHostConfigurationError,
  makeEcsDockerfile,
  makeEcsNodeIngress,
  resolveEcsHostConfiguration,
  resolveManagementRouteTables,
  validateEcsHostTransition,
} from "@/Celld/EcsHostConfig";
import { describe, expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runSync(Effect.result(effect));

const configuration = {
  runtimeVersion: DEFAULT_CELLD_VERSION,
  image: DEFAULT_CELLD_IMAGE,
  capacity: "fargate" as const,
};

describe("Celld ECS host", () => {
  test.effect(
    "routes management S3 traffic privately instead of relying on a public subnet",
    () =>
      Effect.gen(function* () {
        const routeTables = [
          {
            RouteTableId: "rtb-main",
            Associations: [{ Main: true }],
            Routes: [
              {
                DestinationCidrBlock: "0.0.0.0/0",
                GatewayId: "igw-public",
                State: "active",
              },
            ],
          },
          {
            RouteTableId: "rtb-nat",
            Associations: [{ SubnetId: "subnet-nat" }],
            Routes: [
              {
                DestinationCidrBlock: "0.0.0.0/0",
                NatGatewayId: "nat-private",
                State: "active",
              },
            ],
          },
          {
            RouteTableId: "rtb-endpoint",
            Associations: [{ SubnetId: "subnet-endpoint" }],
          },
          {
            RouteTableId: "rtb-owned",
            Associations: [{ SubnetId: "subnet-owned" }],
          },
        ];
        expect(
          yield* resolveManagementRouteTables({
            subnetIds: [
              "subnet-public-a",
              "subnet-public-b",
              "subnet-nat",
              "subnet-endpoint",
              "subnet-owned",
            ],
            routeTables,
            endpoints: [
              {
                VpcEndpointId: "vpce-existing",
                VpcEndpointType: "Gateway",
                State: "available",
                RouteTableIds: ["rtb-endpoint"],
              },
              {
                VpcEndpointId: "vpce-owned",
                VpcEndpointType: "Gateway",
                State: "available",
                RouteTableIds: ["rtb-owned"],
              },
            ],
            ownedEndpointIds: ["vpce-owned"],
          }),
        ).toEqual(["rtb-main", "rtb-owned"]);
        expect(
          Result.isFailure(
            yield* Effect.result(
              resolveManagementRouteTables({
                subnetIds: ["subnet-unknown"],
                routeTables: [],
                endpoints: [],
                ownedEndpointIds: [],
              }),
            ),
          ),
        ).toBe(true);
        expect(
          yield* resolveManagementRouteTables({
            subnetIds: ["subnet-nat"],
            routeTables: [
              {
                ...routeTables[1]!,
                Routes: [
                  {
                    DestinationCidrBlock: "0.0.0.0/0",
                    NatGatewayId: "nat-private",
                    State: "blackhole",
                  },
                ],
              },
            ],
            endpoints: [],
            ownedEndpointIds: [],
          }),
        ).toEqual(["rtb-nat"]);
      }),
  );

  test("keeps Fargate as the default and pins the supported binary", () => {
    const result = run(resolveEcsHostConfiguration({}, {}));
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result)) {
      expect(result.success).toEqual(configuration);
    }
  });

  test("accepts the approved EC2/runsc option shape", () => {
    const result = run(
      resolveEcsHostConfiguration(
        {
          capacity: { type: "ec2", instanceType: "m7i.large" },
          containerRuntime: "runsc",
        },
        {},
      ),
    );
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result)) {
      expect(result.success.capacity).toBe("ec2");
      expect(result.success.instanceType).toBe("m7i.large");
      expect(result.success.containerRuntime).toBe("runsc");
    }
  });

  test("rejects a container runtime on Fargate", () => {
    const result = run(
      resolveEcsHostConfiguration({ containerRuntime: "runsc" }, {}),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(EcsHostConfigurationError);
    }
  });

  test("rejects empty EC2 instance types", () => {
    expect(
      Result.isFailure(
        run(
          resolveEcsHostConfiguration(
            {
              capacity: { type: "ec2", instanceType: " " },
            },
            {},
          ),
        ),
      ),
    ).toBe(true);
  });

  test("rejects an unsupported runtime version or unverified image", () => {
    for (const props of [
      { runtimeVersion: "0.1.0" },
      { runtimeVersion: "0.6.0" },
      { image: "ghcr.io/denoland/celld:latest" },
    ]) {
      expect(
        Result.isFailure(run(resolveEcsHostConfiguration({}, props))),
      ).toBe(true);
    }
  });

  test("rejects legacy fleets and in-place runtime or capacity changes", () => {
    expect(
      Result.isFailure(
        run(validateEcsHostTransition(undefined, configuration)),
      ),
    ).toBe(true);
    for (const previous of [
      { ...configuration, runtimeVersion: "0.1.0" },
      { ...configuration, image: "legacy-image" },
      { ...configuration, capacity: "ec2" as const },
      { ...configuration, instanceType: "m7i.large" },
      { ...configuration, containerRuntime: "runsc" as const },
    ]) {
      expect(
        Result.isFailure(
          run(validateEcsHostTransition(previous, configuration)),
        ),
      ).toBe(true);
    }
    expect(
      Result.isSuccess(
        run(validateEcsHostTransition(configuration, configuration)),
      ),
    ).toBe(true);
  });

  test("keeps Worker caller groups separate from the private management listener", () => {
    const rules = makeEcsNodeIngress("sg-callers", "sg-management", [
      "sg-existing",
    ]);
    expect(rules).toEqual([
      {
        ipProtocol: "tcp",
        fromPort: 8080,
        toPort: 8080,
        referencedGroupId: "sg-callers",
        description: "Worker callers",
      },
      {
        ipProtocol: "tcp",
        fromPort: 8080,
        toPort: 8080,
        referencedGroupId: "sg-existing",
        description: "Existing Worker callers; never attached to nodes",
      },
      {
        ipProtocol: "tcp",
        fromPort: 8081,
        toPort: 8081,
        referencedGroupId: "sg-management",
        description: "Trusted management runner only",
      },
    ]);
  });

  test("advertises exactly the private operator listener, not the public Worker listener", () => {
    const dockerfile = makeEcsDockerfile(DEFAULT_CELLD_IMAGE);
    expect(dockerfile).toContain('--listen "0.0.0.0:8080"');
    expect(dockerfile).toContain(
      '--internal-listen "$IP:8081" --advertise "$IP:8081"',
    );
    expect(dockerfile).toContain("ECS_CONTAINER_METADATA_URI_V4");
    expect(dockerfile).toContain("did not return a private task IPv4 address");
  });

  test("preserves refreshable ECS credentials and forwards SIGTERM without periodic restarts", () => {
    const dockerfile = makeEcsDockerfile(DEFAULT_CELLD_IMAGE);
    expect(dockerfile).toContain("exec celld");
    for (const unsupported of [
      "while true",
      "10800",
      "AWS_ACCESS_KEY_ID",
      "AWS_SESSION_TOKEN",
      "AWS_EC2_METADATA_DISABLED",
      "celld deploy",
      "wrangler",
    ]) {
      expect(dockerfile).not.toContain(unsupported);
    }
  });
});
