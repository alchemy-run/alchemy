import * as AWS from "@alchemy.run/aws";
import {
  InternetGateway,
  Route,
  RouteTable,
  RouteTableAssociation,
  SecurityGroup,
  Subnet,
  Vpc,
} from "@alchemy.run/aws/EC2";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as EC2 from "@distilled.cloud/aws/ec2";
import * as IAM from "@distilled.cloud/aws/iam";
import * as Lambda from "@distilled.cloud/aws/lambda";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:lambda", "live"];
const gpuFixture = `${import.meta.dirname}/fixtures/gpu-function`;

/**
 * A stack-owned public network: managed instances need outbound access to
 * reach Lambda and CloudWatch Logs. Two subnets in different AZs give Lambda
 * room to place GPU instances.
 */
const Network = Effect.gen(function* () {
  const zones = yield* EC2.describeAvailabilityZones({});
  const [azA, azB] = (zones.AvailabilityZones ?? [])
    .filter((zone) => zone.State === "available" && zone.ZoneType === "availability-zone")
    .map((zone) => zone.ZoneName!)
    .sort();
  const vpc = yield* Vpc("ManagedInstancesVpc", { cidrBlock: "10.74.0.0/16" });
  const internetGateway = yield* InternetGateway("ManagedInstancesIgw", { vpcId: vpc.vpcId });
  const routeTable = yield* RouteTable("ManagedInstancesRoutes", { vpcId: vpc.vpcId });
  yield* Route("ManagedInstancesInternetRoute", {
    routeTableId: routeTable.routeTableId,
    destinationCidrBlock: "0.0.0.0/0",
    gatewayId: internetGateway.internetGatewayId,
  });
  const subnets = yield* Effect.forEach(
    [
      ["A", azA!, "10.74.1.0/24"],
      ["B", azB!, "10.74.2.0/24"],
    ] as const,
    ([suffix, availabilityZone, cidrBlock]) =>
      Effect.gen(function* () {
        const subnet = yield* Subnet(`ManagedInstancesSubnet${suffix}`, {
          vpcId: vpc.vpcId,
          cidrBlock,
          availabilityZone,
          mapPublicIpOnLaunch: true,
          // The instances' ENIs keep the internet gateway attached; record
          // the dependency so destroy removes the subnet first.
          tags: { "alchemy:test:internet-gateway": internetGateway.internetGatewayId },
        });
        yield* RouteTableAssociation(`ManagedInstancesSubnet${suffix}Routes`, {
          routeTableId: routeTable.routeTableId,
          subnetId: subnet.subnetId,
        });
        return subnet.subnetId;
      }),
  );
  const securityGroup = yield* SecurityGroup("ManagedInstancesSg", {
    vpcId: vpc.vpcId,
    description: "Lambda Managed Instances",
  });
  return { subnetIds: subnets, securityGroupIds: [securityGroup.groupId] };
});

const getCapacityProvider = (name: string) =>
  Lambda.getCapacityProvider({ CapacityProviderName: name }).pipe(
    Effect.map((r) => r.CapacityProvider),
    Effect.catchTag("ResourceNotFoundException", () => Effect.undefined),
  );

class StillExists extends Data.TaggedError("StillExists")<{ name: string }> {}

const assertCapacityProviderDeleted = (name: string) =>
  getCapacityProvider(name).pipe(
    Effect.flatMap((provider) =>
      provider === undefined ? Effect.void : Effect.fail(new StillExists({ name })),
    ),
    Effect.retry({
      while: (e) => e._tag === "StillExists",
      schedule: Schedule.spaced("5 seconds"),
      times: 24,
    }),
  );

// No functions attach, so Lambda launches no instances and this costs nothing.
test.provider(
  "create, update scaling, and delete a capacity provider",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = (maxVCpuCount: number) =>
        stack.deploy(
          Effect.gen(function* () {
            const network = yield* Network;
            return yield* AWS.Lambda.CapacityProvider("Pool", {
              ...network,
              allowedInstanceTypes: ["m7a.large"],
              maxVCpuCount,
              tags: { team: "lambda" },
            });
          }),
        );

      const created = yield* deploy(16);
      expect(created.state).toBe("Active");
      expect(created.operatorRoleName).toBeDefined();
      const observed = yield* getCapacityProvider(created.capacityProviderName);
      expect(observed?.InstanceRequirements?.AllowedInstanceTypes).toEqual(["m7a.large"]);
      expect(observed?.CapacityProviderScalingConfig?.MaxVCpuCount).toBe(16);
      const observedTags = yield* Lambda.listTags({ Resource: created.capacityProviderArn });
      expect(observedTags.Tags?.team).toBe("lambda");

      const updated = yield* deploy(32);
      expect(updated.capacityProviderArn).toBe(created.capacityProviderArn);
      const afterUpdate = yield* getCapacityProvider(created.capacityProviderName);
      expect(afterUpdate?.CapacityProviderScalingConfig?.MaxVCpuCount).toBe(32);

      yield* stack.destroy();
      yield* assertCapacityProviderDeleted(created.capacityProviderName);
    }),
  { tags, timeout: 600_000 },
);

// Roles this stack's capacity provider `id` created, found by their alchemy tags.
const operatorRolesOf = (stackName: string, stage: string, id: string) =>
  IAM.listRoles.items({}).pipe(
    Stream.filter((role) => role.RoleName.startsWith(stackName.slice(0, 20))),
    Stream.mapEffect((role) =>
      IAM.listRoleTags({ RoleName: role.RoleName }).pipe(
        Effect.map((r) => {
          const tags = Object.fromEntries((r.Tags ?? []).map((t) => [t.Key, t.Value]));
          return tags["alchemy::stack"] === stackName &&
            tags["alchemy::stage"] === stage &&
            tags["alchemy::id"] === id
            ? [role.RoleName]
            : [];
        }),
        Effect.catchTag("NoSuchEntityException", () => Effect.succeed([] as string[])),
      ),
    ),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk).flat()),
  );

// Lambda rejects the scaling config only after the operator role exists. No
// state is persisted for a failed first create, so the provider has to remove
// the role itself.
test.provider(
  "a rejected create leaves no operator role behind",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const failed = yield* stack
        .deploy(
          Effect.gen(function* () {
            const network = yield* Network;
            return yield* AWS.Lambda.CapacityProvider("RejectedPool", {
              ...network,
              allowedInstanceTypes: ["m7a.large"],
              // Below Lambda's minimum for this instance type.
              maxVCpuCount: 2,
            });
          }),
        )
        .pipe(Effect.exit);
      expect(failed._tag).toBe("Failure");
      expect(yield* operatorRolesOf(stack.name, stack.stage, "RejectedPool")).toEqual([]);

      yield* stack.destroy();
    }),
  { tags, timeout: 600_000 },
);

const GpuResponse = Schema.Struct({
  marker: Schema.NullOr(Schema.String),
  gpuCount: Schema.Number,
  nvidiaSmi: Schema.NullOr(Schema.String),
});

class NotServing extends Data.TaggedError("NotServing")<{ message: string }> {}

/**
 * Invoke the unqualified function, which runs `$LATEST.PUBLISHED`. A version
 * that just became Active can still throttle while its first execution
 * environment warms up.
 */
const invokeGpu = (functionName: string, marker: string) =>
  Effect.gen(function* () {
    const response = yield* Lambda.invoke({
      FunctionName: functionName,
      Payload: JSON.stringify({}),
    });
    const payload = response.Payload
      ? yield* response.Payload.pipe(
          Stream.decodeText(),
          Stream.mkString,
          Effect.mapError((cause) => new NotServing({ message: String(cause) })),
        )
      : "";
    if (response.FunctionError) {
      return yield* new NotServing({ message: `${response.FunctionError}: ${payload}` });
    }
    const body = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(GpuResponse))(payload);
    if (body.marker !== marker) {
      return yield* new NotServing({ message: `serving marker ${body.marker}` });
    }
    return body;
  }).pipe(
    Effect.retry({
      while: (e) => e._tag === "NotServing" || e._tag === "TooManyRequestsException",
      schedule: Schedule.spaced("10 seconds"),
      times: 30,
    }),
  );

// Runs one fractional L4 (g6f.large, falling back to a T4 on g4dn.xlarge) for
// the length of the test. Publishing a version launches the instance, so a
// deploy takes several minutes.
test.provider.skipIf(!!process.env.FAST)(
  "GPU-accelerated function runs on its capacity provider",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = (marker: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const network = yield* Network;
            const gpus = yield* AWS.Lambda.CapacityProvider("Gpus", {
              ...network,
              allowedInstanceTypes: ["g6f.large", "g4dn.xlarge"],
              maxVCpuCount: 16,
            });
            const fn = yield* AWS.Lambda.Function("GpuFunction", {
              image: { context: gpuFixture, dockerfile: "Dockerfile" },
              architecture: "x86_64",
              capacityProvider: gpus,
              acceleratorMemorySize: 3,
              memorySize: 2048,
              ephemeralStorageSize: 1024,
              timeout: Duration.minutes(2),
              minExecutionEnvironments: 0,
              maxExecutionEnvironments: 1,
              functionUrl: false,
              env: { GPU_MARKER: marker },
            });
            return { gpus, fn };
          }),
        );

      const first = yield* deploy("one");
      const published = yield* Lambda.getFunctionConfiguration({
        FunctionName: first.fn.functionName,
        Qualifier: "$LATEST.PUBLISHED",
      });
      expect(published.State).toBe("Active");
      expect(published.AcceleratorConfig?.AcceleratorMemorySize).toBe(3);
      expect(published.EphemeralStorage?.Size).toBe(1024);
      expect(
        published.CapacityProviderConfig?.LambdaManagedInstancesCapacityProviderConfig
          .CapacityProviderArn,
      ).toBe(first.gpus.capacityProviderArn);
      const scaling = yield* Lambda.getFunctionScalingConfig({
        FunctionName: first.fn.functionName,
        Qualifier: "$LATEST.PUBLISHED",
      });
      expect(scaling.RequestedFunctionScalingConfig).toEqual({
        MinExecutionEnvironments: 0,
        MaxExecutionEnvironments: 1,
      });

      const response = yield* invokeGpu(first.fn.functionName, "one");
      expect(response.gpuCount).toBeGreaterThan(0);

      // A configuration change republishes $LATEST.PUBLISHED in place.
      const second = yield* deploy("two");
      expect(second.fn.functionArn).toBe(first.fn.functionArn);
      yield* invokeGpu(second.fn.functionName, "two");

      yield* stack.destroy();
      yield* Lambda.getFunction({ FunctionName: first.fn.functionName }).pipe(
        Effect.flatMap(() => Effect.fail(new StillExists({ name: first.fn.functionName }))),
        Effect.catchTag("ResourceNotFoundException", () => Effect.void),
      );
      yield* assertCapacityProviderDeleted(first.gpus.capacityProviderName);
    }),
  { tags, timeout: 2_400_000 },
);
