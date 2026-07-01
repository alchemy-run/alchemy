import * as AWS from "@/AWS";
import { amazonLinux2023, Instance, Subnet, Vpc } from "@/AWS/EC2";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: AWS.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// `list()` enumerates every non-terminated instance in the account/region via
// the paginated `ec2.describeInstances` op (items nested under
// Reservations[].Instances[]). Deploy a real instance, resolve the provider
// from context with the typed `findProvider`, call `list()`, and assert the
// deployed instance appears in the exhaustively paginated result.
test.provider(
  "list enumerates the deployed instance",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const imageId = (yield* amazonLinux2023()) ?? "ami-00000000000000000";

      // The testing account has no default VPC, so provision a VPC + subnet to
      // launch the instance into.
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("ListInstanceVpc", {
            cidrBlock: "10.0.0.0/16",
          });
          const subnet = yield* Subnet("ListInstanceSubnet", {
            vpcId: vpc.vpcId,
            cidrBlock: "10.0.1.0/24",
          });
          return yield* Instance("ListInstance", {
            imageId,
            instanceType: "t3.micro",
            subnetId: subnet.subnetId,
          });
        }),
      );

      const provider = yield* Provider.findProvider(Instance);
      const all = yield* provider.list();

      expect(all.some((x) => x.instanceId === deployed.instanceId)).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 240_000 },
);
