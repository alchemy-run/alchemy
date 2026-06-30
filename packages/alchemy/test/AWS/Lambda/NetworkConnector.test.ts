import * as AWS from "@/AWS";
import { SecurityGroup, Subnet, Vpc } from "@/AWS/EC2";
import { Role } from "@/AWS/IAM";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import * as EC2 from "@distilled.cloud/aws/ec2";
import * as lambdacore from "@distilled.cloud/aws/lambda-core";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Lambda MicroVM network connectors are a preview feature. Creation provisions
// ENIs in the VPC and can take several minutes to reach ACTIVE, and the API
// requires an account that is onboarded to the preview. Gate the live
// lifecycle behind LAMBDA_TEST_NETWORK_CONNECTOR=1 so an entitled account runs
// it unchanged.
test.provider(
  "create, update, list, delete network connector",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const azResult = yield* EC2.describeAvailabilityZones({});
      const az = azResult.AvailabilityZones?.find(
        (z) => z.State === "available",
      )?.ZoneName!;

      const infra = (networkProtocol: lambdacore.NetworkProtocol) =>
        Effect.gen(function* () {
          const vpc = yield* Vpc("ConnectorVpc", { cidrBlock: "10.0.0.0/16" });
          const subnet = yield* Subnet("ConnectorSubnet", {
            vpcId: vpc.vpcId,
            cidrBlock: "10.0.1.0/24",
            availabilityZone: az,
          });
          const sg = yield* SecurityGroup("ConnectorSg", {
            vpcId: vpc.vpcId,
            description: "MicroVM egress",
          });
          const role = yield* Role("ConnectorOperator", {
            assumeRolePolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: "lambda.amazonaws.com" },
                  Action: ["sts:AssumeRole"],
                },
              ],
            },
          });
          const connector = yield* AWS.Lambda.NetworkConnector("Connector", {
            subnetIds: [subnet.subnetId],
            securityGroupIds: [sg.groupId],
            networkProtocol,
            operatorRole: role.roleArn,
          });
          return { connector };
        });

      // --- create ---
      const created = yield* stack.deploy(infra("IPv4"));
      expect(created.connector.state).toBe("ACTIVE");
      expect(created.connector.networkConnectorArn).toContain(
        "network-connector",
      );

      const fetched = yield* lambdacore.getNetworkConnector({
        Identifier: created.connector.networkConnectorId,
      });
      expect(fetched.State).toBe("ACTIVE");

      // --- update (network protocol) ---
      const updated = yield* stack.deploy(infra("DualStack"));
      expect(updated.connector.networkConnectorArn).toBe(
        created.connector.networkConnectorArn,
      );
      expect(updated.connector.networkProtocol).toBe("DualStack");

      // --- list ---
      const provider = yield* Provider.findProvider(
        AWS.Lambda.NetworkConnector,
      );
      const all = yield* provider.list();
      expect(
        all.some(
          (c) => c.networkConnectorId === created.connector.networkConnectorId,
        ),
      ).toBe(true);

      // --- delete ---
      yield* stack.destroy();
      const afterDestroy = yield* lambdacore
        .getNetworkConnector({
          Identifier: created.connector.networkConnectorId,
        })
        .pipe(
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
      expect(afterDestroy).toBeUndefined();
    }).pipe(
      Effect.tap(() => stack.destroy()),
      Effect.onError(() => stack.destroy().pipe(Effect.ignore)),
    ),
  { timeout: 1_500_000 },
);
