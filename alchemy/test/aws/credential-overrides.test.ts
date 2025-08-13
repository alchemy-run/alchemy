import { DescribeVpcsCommand, EC2Client } from "@aws-sdk/client-ec2";
import { describe, expect } from "vitest";
import { alchemy } from "../../src/alchemy.ts";
import { InternetGatewayAttachment } from "../../src/aws/ec2/internet-gateway-attachment.ts";
import { InternetGateway } from "../../src/aws/ec2/internet-gateway.ts";
import { RouteTable } from "../../src/aws/ec2/route-table.ts";
import { Route } from "../../src/aws/ec2/route.ts";
import { SecurityGroup } from "../../src/aws/ec2/security-group.ts";
import { Subnet } from "../../src/aws/ec2/subnet.ts";
import { Vpc } from "../../src/aws/ec2/vpc.ts";
import { destroy } from "../../src/destroy.ts";
import { BRANCH_PREFIX } from "../util.ts";

import "../../src/test/vitest.ts";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

describe("AWS Credential Overrides", () => {
  /**
   * Test resource-level credential overrides
   *
   * This test creates resources with explicit credential overrides and verifies
   * that each resource uses its own specified credentials.
   */
  test("resource-level credential overrides", async (scope) => {
    const vpcName = `${BRANCH_PREFIX}-resource-creds-vpc`;
    const subnetName = `${BRANCH_PREFIX}-resource-creds-subnet`;
    const igwName = `${BRANCH_PREFIX}-resource-creds-igw`;
    const sgName = `${BRANCH_PREFIX}-resource-creds-sg`;
    const rtName = `${BRANCH_PREFIX}-resource-creds-rt`;

    let vpc;
    let subnet;
    let igw;
    let _igwAttachment;
    let sg;
    let routeTable;
    let route;

    try {
      // Create VPC with explicit credential overrides
      vpc = await Vpc(vpcName, {
        cidrBlock: "10.0.0.0/16",
        region: "us-west-2",
        profile: process.env.AWS_PROFILE || "default",
        tags: {
          Name: vpcName,
          TestType: "resource-level-credentials",
        },
      });

      // Verify VPC was created in the correct region
      const ec2Client = new EC2Client({
        region: "us-west-2",
        profile: process.env.AWS_PROFILE || "default",
      });

      const vpcResponse = await ec2Client.send(
        new DescribeVpcsCommand({
          VpcIds: [vpc.vpcId],
        }),
      );

      expect(vpcResponse.Vpcs).toHaveLength(1);
      expect(vpcResponse.Vpcs![0].VpcId).toBe(vpc.vpcId);
      expect(vpcResponse.Vpcs![0].CidrBlock).toBe("10.0.0.0/16");

      // Create subnet with same credential overrides
      subnet = await Subnet(subnetName, {
        vpc: vpc,
        cidrBlock: "10.0.1.0/24",
        availabilityZone: "us-west-2a",
        region: "us-west-2",
        profile: process.env.AWS_PROFILE || "default",
        tags: {
          Name: subnetName,
          TestType: "resource-level-credentials",
        },
      });

      // Create Internet Gateway with credential overrides
      igw = await InternetGateway(igwName, {
        region: "us-west-2",
        profile: process.env.AWS_PROFILE || "default",
        tags: {
          Name: igwName,
          TestType: "resource-level-credentials",
        },
      });

      // Attach Internet Gateway to VPC
      _igwAttachment = await InternetGatewayAttachment(
        `${BRANCH_PREFIX}-resource-creds-igw-attachment`,
        {
          internetGateway: igw,
          vpc: vpc,
          region: "us-west-2",
          profile: process.env.AWS_PROFILE || "default",
        },
      );

      // Create Security Group with credential overrides
      sg = await SecurityGroup(sgName, {
        vpc: vpc,
        groupName: sgName,
        description: "Test security group with credential overrides",
        region: "us-west-2",
        profile: process.env.AWS_PROFILE || "default",
        tags: {
          Name: sgName,
          TestType: "resource-level-credentials",
        },
      });

      // Create Route Table with credential overrides
      routeTable = await RouteTable(rtName, {
        vpc: vpc,
        region: "us-west-2",
        profile: process.env.AWS_PROFILE || "default",
        tags: {
          Name: rtName,
          TestType: "resource-level-credentials",
        },
      });

      // Create Route with credential overrides
      route = await Route(`${BRANCH_PREFIX}-resource-creds-route`, {
        routeTable: routeTable,
        destinationCidrBlock: "0.0.0.0/0",
        target: { internetGateway: igw },
        region: "us-west-2",
        profile: process.env.AWS_PROFILE || "default",
      });

      // Verify all resources were created successfully
      expect(vpc.vpcId).toBeDefined();
      expect(subnet.subnetId).toBeDefined();
      expect(igw.internetGatewayId).toBeDefined();
      expect(sg.groupId).toBeDefined();
      expect(routeTable.routeTableId).toBeDefined();
      expect(route.routeTableId).toBeDefined();

      console.log(
        "✅ All resources created successfully with credential overrides",
      );
    } finally {
      // Clean up resources
      console.log("Starting cleanup...");
      await destroy(scope);
      console.log("Cleanup completed!");
    }
  });

  /**
   * Test mixed credential scenarios
   *
   * This test creates resources with different credential configurations
   * to verify that each resource can use its own credentials independently.
   */
  test("mixed credential scenarios", async (scope) => {
    const vpc1Name = `${BRANCH_PREFIX}-mixed-creds-vpc1`;
    const vpc2Name = `${BRANCH_PREFIX}-mixed-creds-vpc2`;

    let vpc1;
    let vpc2;

    try {
      // Create first VPC with explicit credentials
      vpc1 = await Vpc(vpc1Name, {
        cidrBlock: "10.1.0.0/16",
        region: "us-west-2",
        profile: process.env.AWS_PROFILE || "default",
        tags: {
          Name: vpc1Name,
          TestType: "mixed-credentials",
        },
      });

      // Create second VPC with different explicit credentials (same profile but different CIDR)
      vpc2 = await Vpc(vpc2Name, {
        cidrBlock: "10.2.0.0/16",
        region: "us-west-2",
        profile: process.env.AWS_PROFILE || "default",
        tags: {
          Name: vpc2Name,
          TestType: "mixed-credentials",
        },
      });

      // Verify both VPCs were created
      expect(vpc1.vpcId).toBeDefined();
      expect(vpc2.vpcId).toBeDefined();
      expect(vpc1.vpcId).not.toBe(vpc2.vpcId);

      console.log("✅ Mixed credential scenario completed successfully");
    } finally {
      // Clean up resources
      console.log("Starting cleanup...");
      await destroy(scope);
      console.log("Cleanup completed!");
    }
  });

  /**
   * Test error scenarios with invalid credentials
   *
   * This test verifies that proper error handling occurs when invalid
   * credential configurations are provided.
   */
  test("error scenarios with invalid credentials", async (_scope) => {
    // Test invalid credential properties
    try {
      await Vpc("test-vpc", {
        cidrBlock: "10.0.0.0/16",
        region: 123 as any, // Invalid type
      });
      // If we get here, the test should fail
      expect(true).toBe(false);
    } catch (error: any) {
      expect(error.message).toContain(
        "Invalid AWS configuration in resource properties",
      );
    }

    console.log("✅ Error scenarios handled correctly");
  });
});
