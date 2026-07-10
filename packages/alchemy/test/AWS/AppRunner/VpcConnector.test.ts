import * as AWS from "@/AWS";
import { VpcConnector } from "@/AWS/AppRunner";
import * as Test from "@/Test/Vitest";
import * as apprunner from "@distilled.cloud/aws/apprunner";
import * as ec2 from "@distilled.cloud/aws/ec2";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { getDefaultVpc } from "../DefaultVpc.ts";

const { test } = Test.make({ providers: AWS.providers() });

// VPC connector creation is fast (deletion marks it INACTIVE immediately;
// ENI teardown happens asynchronously server-side), so the lifecycle runs
// ungated on the account's default VPC.
test.provider(
  "create and destroy a VPC connector on the default VPC",
  (stack) =>
    Effect.gen(function* () {
      // Clean slate in case a previous run died mid-flight.
      yield* stack.destroy();

      const { vpcId } = yield* getDefaultVpc;
      const subnets = yield* ec2.describeSubnets({
        Filters: [{ Name: "vpc-id", Values: [vpcId] }],
      });
      const subnetIds = (subnets.Subnets ?? [])
        .map((s) => s.SubnetId)
        .filter((id): id is string => id !== undefined)
        .sort()
        .slice(0, 2);
      expect(subnetIds.length).toBeGreaterThan(0);

      const connector = yield* stack.deploy(
        VpcConnector("Connector", {
          vpcConnectorName: "alchemy-test-apprunner-vc",
          subnets: subnetIds,
        }),
      );
      expect(connector.vpcConnectorName).toBe("alchemy-test-apprunner-vc");
      expect(connector.vpcConnectorArn).toContain(
        ":vpcconnector/alchemy-test-apprunner-vc/",
      );
      // App Runner returns lowercase statuses despite documenting uppercase.
      expect(connector.status.toUpperCase()).toBe("ACTIVE");
      expect(connector.vpcConnectorRevision).toBeGreaterThanOrEqual(1);

      // Out-of-band verification via distilled.
      const described = yield* apprunner.describeVpcConnector({
        VpcConnectorArn: connector.vpcConnectorArn,
      });
      expect(described.VpcConnector.Status?.toUpperCase()).toBe("ACTIVE");
      expect([...(described.VpcConnector.Subnets ?? [])].sort()).toEqual(
        subnetIds,
      );
      // The default security group is applied when none is specified.
      expect(
        (described.VpcConnector.SecurityGroups ?? []).length,
      ).toBeGreaterThan(0);

      // Destroy and verify deletion out-of-band: deleted connectors read
      // INACTIVE (or disappear entirely).
      yield* stack.destroy();
      const after = yield* apprunner
        .describeVpcConnector({
          VpcConnectorArn: connector.vpcConnectorArn,
        })
        .pipe(
          Effect.map((r) =>
            (r.VpcConnector.Status ?? "INACTIVE").toUpperCase(),
          ),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed("GONE" as const),
          ),
        );
      expect(["INACTIVE", "GONE"]).toContain(after);
    }),
  { timeout: 180_000 },
);
