import {
  DescribeInternetGatewaysCommand,
  EC2Client,
} from "@aws-sdk/client-ec2";
import { describe, expect } from "vitest";
import { alchemy } from "../../../src/alchemy.ts";
import {
  INTERNET_GATEWAY_TIMEOUT,
  InternetGateway,
} from "../../../src/aws/ec2/internet-gateway.ts";
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

describe.skipIf(!process.env.ALL_TESTS)("InternetGateway", () => {
  test(
    "create and delete internet gateway",
    async (scope) => {
      const igwName = `${BRANCH_PREFIX}-alchemy-test-igw`;
      let internetGateway: Awaited<ReturnType<typeof InternetGateway>>;

      try {
        // Create the Internet Gateway
        internetGateway = await InternetGateway(igwName, {
          tags: {
            Name: igwName,
            Environment: "test",
          },
        });

        expect(internetGateway.internetGatewayId).toBeTruthy();
        expect(internetGateway.state).toBe("available");

        // Verify Internet Gateway exists
        const describeResponse = await ec2.send(
          new DescribeInternetGatewaysCommand({
            InternetGatewayIds: [internetGateway.internetGatewayId],
          }),
        );
        const igw = describeResponse.InternetGateways?.[0];
        expect(igw?.InternetGatewayId).toBe(internetGateway.internetGatewayId);
        expect(igw?.Attachments).toHaveLength(0); // Should not be attached to any VPC
      } finally {
        // Always clean up, even if test fails
        await destroy(scope);
      }
    },
    INTERNET_GATEWAY_TIMEOUT.maxAttempts * INTERNET_GATEWAY_TIMEOUT.delayMs +
      30000, // Resource timeout + 30s buffer
  );

  test(
    "create internet gateway with credential overrides",
    async (scope) => {
      const igwName = `${BRANCH_PREFIX}-alchemy-test-igw-creds`;
      let internetGateway: Awaited<ReturnType<typeof InternetGateway>>;

      try {
        // Create Internet Gateway with explicit region override
        internetGateway = await InternetGateway(igwName, {
          region: "us-west-2", // Override region
          tags: {
            Name: igwName,
            Environment: "test",
            CredentialTest: "true",
          },
        });

        expect(internetGateway.internetGatewayId).toBeTruthy();
        expect(internetGateway.state).toBe("available");

        // Verify Internet Gateway exists in the specified region
        const regionalEc2 = new EC2Client({ region: "us-west-2" });
        const describeResponse = await regionalEc2.send(
          new DescribeInternetGatewaysCommand({
            InternetGatewayIds: [internetGateway.internetGatewayId],
          }),
        );
        const igw = describeResponse.InternetGateways?.[0];
        expect(igw?.InternetGatewayId).toBe(internetGateway.internetGatewayId);
        expect(igw?.Attachments).toHaveLength(0);
      } finally {
        // Always clean up, even if test fails
        await destroy(scope);
      }
    },
    INTERNET_GATEWAY_TIMEOUT.maxAttempts * INTERNET_GATEWAY_TIMEOUT.delayMs +
      30000, // Resource timeout + 30s buffer
  );

  test(
    "create internet gateway with profile override",
    async (scope) => {
      const igwName = `${BRANCH_PREFIX}-alchemy-test-igw-profile`;
      let internetGateway: Awaited<ReturnType<typeof InternetGateway>>;

      try {
        // Create Internet Gateway with profile override
        internetGateway = await InternetGateway(igwName, {
          profile: process.env.AWS_PROFILE || "default", // Override profile
          region: "us-west-2",
          tags: {
            Name: igwName,
            Environment: "test",
            ProfileTest: "true",
          },
        });

        expect(internetGateway.internetGatewayId).toBeTruthy();
        expect(internetGateway.state).toBe("available");

        // Verify Internet Gateway exists
        const describeResponse = await ec2.send(
          new DescribeInternetGatewaysCommand({
            InternetGatewayIds: [internetGateway.internetGatewayId],
          }),
        );
        const igw = describeResponse.InternetGateways?.[0];
        expect(igw?.InternetGatewayId).toBe(internetGateway.internetGatewayId);
      } finally {
        // Always clean up, even if test fails
        await destroy(scope);
      }
    },
    INTERNET_GATEWAY_TIMEOUT.maxAttempts * INTERNET_GATEWAY_TIMEOUT.delayMs +
      30000, // Resource timeout + 30s buffer
  );
});
