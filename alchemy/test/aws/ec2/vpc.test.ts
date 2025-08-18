import { DescribeVpcsCommand, EC2Client } from "@aws-sdk/client-ec2";
import { describe, expect } from "vitest";
import { alchemy } from "../../../src/alchemy.ts";
import { Vpc, VPC_TIMEOUT } from "../../../src/aws/ec2/vpc.ts";
import { destroy } from "../../../src/destroy.ts";
import { BRANCH_PREFIX } from "../../util.ts";

import "../../../src/test/vitest.ts";

// Set test environment variables for AWS tests
process.env.AWS_PROFILE = process.env.AWS_PROFILE || "default";
process.env.AWS_REGION = process.env.AWS_REGION || "us-west-2";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

const ec2 = new EC2Client({});

describe.skipIf(!process.env.ALL_TESTS)("VPC", () => {
  test(
    "create and delete VPC",
    async (scope) => {
      const vpcName = `${BRANCH_PREFIX}-alchemy-test-vpc`;
      let vpc: Awaited<ReturnType<typeof Vpc>>;

      try {
        vpc = await Vpc(vpcName, {
          cidrBlock: "10.0.0.0/16",
          enableDnsSupport: true,
          enableDnsHostnames: true,
          tags: {
            Name: vpcName,
            Environment: "test",
          },
        });

        expect(vpc.vpcId).toBeTruthy();
        expect(vpc.cidrBlock).toBe("10.0.0.0/16");
        expect(vpc.enableDnsSupport).toBe(true);
        expect(vpc.enableDnsHostnames).toBe(true);
        expect(vpc.tags).toEqual({
          Name: vpcName,
          Environment: "test",
        });

        // Verify VPC exists and is available
        const describeResponse = await ec2.send(
          new DescribeVpcsCommand({
            VpcIds: [vpc.vpcId],
          }),
        );
        expect(describeResponse.Vpcs?.[0]?.State).toBe("available");
        expect(describeResponse.Vpcs?.[0]?.CidrBlock).toBe("10.0.0.0/16");
      } finally {
        // Always clean up, even if test fails
        console.log("Starting cleanup...");
        await destroy(scope);
        console.log("Cleanup completed!");
      }
    },
    VPC_TIMEOUT.maxAttempts * VPC_TIMEOUT.delayMs + 30000, // Resource timeout + 30s buffer
  );

  test(
    "create VPC with resource-level credential overrides",
    async (scope) => {
      const vpcName = `${BRANCH_PREFIX}-alchemy-test-vpc-override`;
      let vpc: Awaited<ReturnType<typeof Vpc>>;

      try {
        // Test that resource-level region override works
        vpc = await Vpc(vpcName, {
          cidrBlock: "10.1.0.0/16",
          region: "us-west-2", // Explicit region override
          tags: {
            Name: vpcName,
            Environment: "test-override",
          },
        });

        expect(vpc.vpcId).toBeTruthy();
        expect(vpc.cidrBlock).toBe("10.1.0.0/16");
        expect(vpc.region).toBe("us-west-2");
        expect(vpc.tags).toEqual({
          Name: vpcName,
          Environment: "test-override",
        });

        // Verify VPC exists and is available
        const describeResponse = await ec2.send(
          new DescribeVpcsCommand({
            VpcIds: [vpc.vpcId],
          }),
        );
        expect(describeResponse.Vpcs?.[0]?.State).toBe("available");
        expect(describeResponse.Vpcs?.[0]?.CidrBlock).toBe("10.1.0.0/16");
      } finally {
        await destroy(scope);
      }
    },
    VPC_TIMEOUT.maxAttempts * VPC_TIMEOUT.delayMs + 30000,
  );

  test(
    "create VPC with scope-level credentials",
    async (scope) => {
      const vpcName = `${BRANCH_PREFIX}-alchemy-test-vpc-scope`;

      try {
        // Test scope-level credential inheritance
        await alchemy.run(
          "test-scope",
          {
            aws: {
              region: "us-west-2",
              profile: process.env.AWS_PROFILE || "default",
            },
          },
          async () => {
            const vpc = await Vpc(vpcName, {
              cidrBlock: "10.2.0.0/16",
              tags: {
                Name: vpcName,
                Environment: "test-scope",
              },
            });

            expect(vpc.vpcId).toBeTruthy();
            expect(vpc.cidrBlock).toBe("10.2.0.0/16");
            expect(vpc.tags).toEqual({
              Name: vpcName,
              Environment: "test-scope",
            });

            // Verify VPC exists and is available
            const describeResponse = await ec2.send(
              new DescribeVpcsCommand({
                VpcIds: [vpc.vpcId],
              }),
            );
            expect(describeResponse.Vpcs?.[0]?.State).toBe("available");
            expect(describeResponse.Vpcs?.[0]?.CidrBlock).toBe("10.2.0.0/16");
          },
        );
      } finally {
        await destroy(scope);
      }
    },
    VPC_TIMEOUT.maxAttempts * VPC_TIMEOUT.delayMs + 30000,
  );

  test(
    "resource-level overrides take precedence over scope-level",
    async (scope) => {
      const vpcName = `${BRANCH_PREFIX}-alchemy-test-vpc-precedence`;

      try {
        // Test that resource-level credentials override scope-level
        await alchemy.run(
          "test-precedence",
          {
            aws: {
              region: "us-east-1", // Scope sets us-east-1
              profile: process.env.AWS_PROFILE || "default",
            },
          },
          async () => {
            const vpc = await Vpc(vpcName, {
              cidrBlock: "10.3.0.0/16",
              region: "us-west-2", // Resource overrides to us-west-2
              tags: {
                Name: vpcName,
                Environment: "test-precedence",
              },
            });

            expect(vpc.vpcId).toBeTruthy();
            expect(vpc.cidrBlock).toBe("10.3.0.0/16");
            expect(vpc.region).toBe("us-west-2"); // Should use resource-level override
            expect(vpc.tags).toEqual({
              Name: vpcName,
              Environment: "test-precedence",
            });

            // Verify VPC exists and is available in the correct region
            const describeResponse = await ec2.send(
              new DescribeVpcsCommand({
                VpcIds: [vpc.vpcId],
              }),
            );
            expect(describeResponse.Vpcs?.[0]?.State).toBe("available");
            expect(describeResponse.Vpcs?.[0]?.CidrBlock).toBe("10.3.0.0/16");
          },
        );
      } finally {
        await destroy(scope);
      }
    },
    VPC_TIMEOUT.maxAttempts * VPC_TIMEOUT.delayMs + 30000,
  );
});
