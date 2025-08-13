import { DescribeRouteTablesCommand, EC2Client } from "@aws-sdk/client-ec2";
import { describe, expect } from "vitest";
import { alchemy } from "../../../src/alchemy.ts";
import { RouteTable } from "../../../src/aws/ec2/route-table.ts";
import { Vpc } from "../../../src/aws/ec2/vpc.ts";
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

describe.skipIf(!process.env.ALL_TESTS)("RouteTable", () => {
  test("create route table", async (scope) => {
    const vpcName = `${BRANCH_PREFIX}-alchemy-test-rt-vpc`;
    const rtName = `${BRANCH_PREFIX}-alchemy-test-rt`;
    let vpc: Awaited<ReturnType<typeof Vpc>>;
    let routeTable: Awaited<ReturnType<typeof RouteTable>>;

    try {
      // First create a VPC
      vpc = await Vpc(vpcName, {
        cidrBlock: "10.0.0.0/16",
        tags: { Name: vpcName },
      });

      routeTable = await RouteTable(rtName, {
        vpc,
        tags: {
          Name: rtName,
          Environment: "test",
        },
      });

      expect(routeTable.routeTableId).toBeTruthy();
      expect(routeTable.vpcId).toBe(vpc.vpcId);

      // Verify route table exists
      const describeResponse = await ec2.send(
        new DescribeRouteTablesCommand({
          RouteTableIds: [routeTable.routeTableId],
        }),
      );
      const rt = describeResponse.RouteTables?.[0];
      expect(rt?.RouteTableId).toBe(routeTable.routeTableId);
      expect(rt?.VpcId).toBe(vpc.vpcId);
    } finally {
      // Always clean up, even if test fails
      await destroy(scope);
    }
  });

  test("create route table with credential overrides", async (scope) => {
    const vpcName = `${BRANCH_PREFIX}-alchemy-test-rt-creds-vpc`;
    const rtName = `${BRANCH_PREFIX}-alchemy-test-rt-creds`;
    let vpc: Awaited<ReturnType<typeof Vpc>>;
    let routeTable: Awaited<ReturnType<typeof RouteTable>>;

    try {
      // First create a VPC with region override
      vpc = await Vpc(vpcName, {
        cidrBlock: "10.0.0.0/16",
        region: "us-west-2", // Override region
        tags: { Name: vpcName },
      });

      // Create Route Table with explicit region override
      routeTable = await RouteTable(rtName, {
        vpc,
        region: "us-west-2", // Override region
        tags: {
          Name: rtName,
          Environment: "test",
          CredentialTest: "true",
        },
      });

      expect(routeTable.routeTableId).toBeTruthy();
      expect(routeTable.vpcId).toBe(vpc.vpcId);

      // Verify route table exists in the specified region
      const regionalEc2 = new EC2Client({ region: "us-west-2" });
      const describeResponse = await regionalEc2.send(
        new DescribeRouteTablesCommand({
          RouteTableIds: [routeTable.routeTableId],
        }),
      );
      const rt = describeResponse.RouteTables?.[0];
      expect(rt?.RouteTableId).toBe(routeTable.routeTableId);
      expect(rt?.VpcId).toBe(vpc.vpcId);
    } finally {
      // Always clean up, even if test fails
      await destroy(scope);
    }
  });

  test("create route table with profile override", async (scope) => {
    const vpcName = `${BRANCH_PREFIX}-alchemy-test-rt-profile-vpc`;
    const rtName = `${BRANCH_PREFIX}-alchemy-test-rt-profile`;
    let vpc: Awaited<ReturnType<typeof Vpc>>;
    let routeTable: Awaited<ReturnType<typeof RouteTable>>;

    try {
      // First create a VPC with profile override
      vpc = await Vpc(vpcName, {
        cidrBlock: "10.0.0.0/16",
        profile: process.env.AWS_PROFILE || "default", // Override profile
        region: "us-west-2",
        tags: { Name: vpcName },
      });

      // Create Route Table with profile override
      routeTable = await RouteTable(rtName, {
        vpc,
        profile: process.env.AWS_PROFILE || "default", // Override profile
        region: "us-west-2",
        tags: {
          Name: rtName,
          Environment: "test",
          ProfileTest: "true",
        },
      });

      expect(routeTable.routeTableId).toBeTruthy();
      expect(routeTable.vpcId).toBe(vpc.vpcId);

      // Verify route table exists
      const describeResponse = await ec2.send(
        new DescribeRouteTablesCommand({
          RouteTableIds: [routeTable.routeTableId],
        }),
      );
      const rt = describeResponse.RouteTables?.[0];
      expect(rt?.RouteTableId).toBe(routeTable.routeTableId);
      expect(rt?.VpcId).toBe(vpc.vpcId);
    } finally {
      // Always clean up, even if test fails
      await destroy(scope);
    }
  });
});
