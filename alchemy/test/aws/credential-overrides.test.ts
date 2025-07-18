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
   * Test scope-level credential inheritance across multiple resources
   *
   * This test creates a scope with AWS credential overrides and verifies that
   * all resources created within that scope inherit those credentials.
   */
  test("scope-level credential inheritance", async (scope) => {
    // Create a scope with AWS credential overrides
    await alchemy.run(
      "credential-test",
      {
        // Scope-level AWS credential overrides
        awsRegion: "us-west-2",
        awsProfile: "test9-374080338393",
      },
      async () => {
        const vpcName = `${BRANCH_PREFIX}-scope-creds-vpc`;
        const subnetName = `${BRANCH_PREFIX}-scope-creds-subnet`;
        const igwName = `${BRANCH_PREFIX}-scope-creds-igw`;
        const sgName = `${BRANCH_PREFIX}-scope-creds-sg`;
        const rtName = `${BRANCH_PREFIX}-scope-creds-rt`;

        let vpc;
        let subnet;
        let igw;
        let igwAttachment;
        let sg;
        let routeTable;
        let route;

        try {
          // Create resources without explicit credential overrides
          // They should inherit credentials from the scope
          vpc = await Vpc(vpcName, {
            cidrBlock: "10.0.0.0/16",
            tags: { Name: vpcName, CredTest: "scope-level" },
          });

          subnet = await Subnet(subnetName, {
            vpc,
            cidrBlock: "10.0.1.0/24",
            availabilityZone: "us-west-2a",
            mapPublicIpOnLaunch: true,
            tags: { Name: subnetName, CredTest: "scope-level" },
          });

          igw = await InternetGateway(igwName, {
            tags: { Name: igwName, CredTest: "scope-level" },
          });

          igwAttachment = await InternetGatewayAttachment(
            `${igwName}-attachment`,
            {
              internetGateway: igw,
              vpc,
            },
          );

          sg = await SecurityGroup(sgName, {
            vpc,
            groupName: sgName,
            description: "Security group for credential test",
            tags: { Name: sgName, CredTest: "scope-level" },
          });

          routeTable = await RouteTable(rtName, {
            vpc,
            tags: { Name: rtName, CredTest: "scope-level" },
          });

          route = await Route(`${rtName}-default-route`, {
            routeTable,
            destinationCidrBlock: "0.0.0.0/0",
            target: { internetGateway: igw },
          });

          // Verify resources were created in the specified region
          const regionalEc2 = new EC2Client({ region: "us-west-2" });

          // Verify VPC exists in the specified region
          const describeVpcResponse = await regionalEc2.send(
            new DescribeVpcsCommand({
              VpcIds: [vpc.vpcId],
            }),
          );

          expect(describeVpcResponse.Vpcs?.length).toBe(1);
          expect(describeVpcResponse.Vpcs?.[0]?.VpcId).toBe(vpc.vpcId);

          // Verify VPC has the correct tags
          const vpcTags = describeVpcResponse.Vpcs?.[0]?.Tags;
          const credTestTag = vpcTags?.find((tag) => tag.Key === "CredTest");
          expect(credTestTag?.Value).toBe("scope-level");

          // Additional verification could be done for other resources
          // but this is sufficient to demonstrate scope-level credential inheritance
        } finally {
          // Clean up resources
          await destroy(scope);
        }
      },
    );
  });

  /**
   * Test resource-level credential overrides that override scope-level credentials
   *
   * This test creates a scope with AWS credential overrides and then creates resources
   * with their own credential overrides that should take precedence over the scope-level ones.
   */
  test("resource-level credential overrides", async (scope) => {
    // Create a scope with AWS credential overrides
    await alchemy.run(
      "credential-test",
      {
        // Scope-level AWS credential overrides
        awsRegion: "us-east-1", // Different region than what we'll use for resources
        awsProfile: "test9-374080338393",
      },
      async () => {
        const vpcName = `${BRANCH_PREFIX}-resource-creds-vpc`;
        const subnetName = `${BRANCH_PREFIX}-resource-creds-subnet`;
        const igwName = `${BRANCH_PREFIX}-resource-creds-igw`;

        let vpc;
        let subnet;
        let igw;
        let igwAttachment;

        try {
          // Create resources with explicit credential overrides
          // These should override the scope-level credentials
          vpc = await Vpc(vpcName, {
            cidrBlock: "10.0.0.0/16",
            region: "us-west-2", // Override scope-level region
            tags: { Name: vpcName, CredTest: "resource-level" },
          });

          subnet = await Subnet(subnetName, {
            vpc,
            cidrBlock: "10.0.1.0/24",
            availabilityZone: "us-west-2a",
            region: "us-west-2", // Override scope-level region
            mapPublicIpOnLaunch: true,
            tags: { Name: subnetName, CredTest: "resource-level" },
          });

          igw = await InternetGateway(igwName, {
            region: "us-west-2", // Override scope-level region
            tags: { Name: igwName, CredTest: "resource-level" },
          });

          igwAttachment = await InternetGatewayAttachment(
            `${igwName}-attachment`,
            {
              internetGateway: igw,
              vpc,
              region: "us-west-2", // Override scope-level region
            },
          );

          // Verify resources were created in the resource-specified region (us-west-2)
          // not the scope-specified region (us-east-1)
          const resourceRegionEc2 = new EC2Client({ region: "us-west-2" });
          const scopeRegionEc2 = new EC2Client({ region: "us-east-1" });

          // Verify VPC exists in the resource-specified region
          const resourceRegionResponse = await resourceRegionEc2.send(
            new DescribeVpcsCommand({
              VpcIds: [vpc.vpcId],
            }),
          );

          expect(resourceRegionResponse.Vpcs?.length).toBe(1);
          expect(resourceRegionResponse.Vpcs?.[0]?.VpcId).toBe(vpc.vpcId);

          // Verify VPC does NOT exist in the scope-specified region
          try {
            await scopeRegionEc2.send(
              new DescribeVpcsCommand({
                VpcIds: [vpc.vpcId],
              }),
            );
            // If we get here, the VPC was found in the wrong region
            throw new Error(
              `VPC ${vpc.vpcId} was found in us-east-1 but should only exist in us-west-2`,
            );
          } catch (error: any) {
            // We expect a "VpcID.NotFound" error
            expect(error.name).toBe("InvalidVpcID.NotFound");
          }
        } finally {
          // Clean up resources
          await destroy(scope);
        }
      },
    );
  });

  /**
   * Test nested scope credential inheritance behavior
   *
   * This test creates nested scopes with different AWS credential overrides
   * and verifies that resources inherit credentials from their immediate parent scope.
   */
  test("nested scope credential inheritance", async (scope) => {
    // Create a parent scope with AWS credential overrides
    await alchemy.run(
      "parent-scope",
      {
        // Parent scope-level AWS credential overrides
        awsRegion: "us-west-2",
        awsProfile: "test9-374080338393",
      },
      async () => {
        const parentVpcName = `${BRANCH_PREFIX}-parent-scope-vpc`;
        let parentVpc;

        try {
          // Create a resource in the parent scope
          parentVpc = await Vpc(parentVpcName, {
            cidrBlock: "10.0.0.0/16",
            tags: { Name: parentVpcName, CredTest: "parent-scope" },
          });

          // Create a child scope with different AWS credential overrides
          await alchemy.run(
            "child-scope",
            {
              // Child scope-level AWS credential overrides
              // These should override the parent scope's credentials for resources in this scope
              awsRegion: "us-west-2", // Same region but could be different
              awsProfile: "test9-374080338393",
              // Additional metadata to distinguish from parent scope
              environment: "child",
            },
            async () => {
              const childVpcName = `${BRANCH_PREFIX}-child-scope-vpc`;
              let childVpc;

              try {
                // Create a resource in the child scope
                childVpc = await Vpc(childVpcName, {
                  cidrBlock: "10.1.0.0/16",
                  tags: { Name: childVpcName, CredTest: "child-scope" },
                });

                // Verify both VPCs exist in their respective regions
                const ec2 = new EC2Client({ region: "us-west-2" });

                // Get both VPCs in a single call
                const describeVpcsResponse = await ec2.send(
                  new DescribeVpcsCommand({
                    VpcIds: [parentVpc.vpcId, childVpc.vpcId],
                  }),
                );

                expect(describeVpcsResponse.Vpcs?.length).toBe(2);

                // Find the parent VPC
                const foundParentVpc = describeVpcsResponse.Vpcs?.find(
                  (vpc) => vpc.VpcId === parentVpc.vpcId,
                );
                expect(foundParentVpc).toBeTruthy();

                // Verify parent VPC has the correct tags
                const parentVpcTags = foundParentVpc?.Tags;
                const parentCredTestTag = parentVpcTags?.find(
                  (tag) => tag.Key === "CredTest",
                );
                expect(parentCredTestTag?.Value).toBe("parent-scope");

                // Find the child VPC
                const foundChildVpc = describeVpcsResponse.Vpcs?.find(
                  (vpc) => vpc.VpcId === childVpc.vpcId,
                );
                expect(foundChildVpc).toBeTruthy();

                // Verify child VPC has the correct tags
                const childVpcTags = foundChildVpc?.Tags;
                const childCredTestTag = childVpcTags?.find(
                  (tag) => tag.Key === "CredTest",
                );
                expect(childCredTestTag?.Value).toBe("child-scope");
              } finally {
                // Child scope resources are cleaned up automatically when the child scope exits
              }
            },
          );
        } finally {
          // Clean up parent scope resources
          await destroy(scope);
        }
      },
    );
  });

  /**
   * Test error scenarios with invalid credentials
   *
   * This test verifies that helpful error messages are provided when invalid
   * AWS credentials are used.
   */
  test("error scenarios with invalid credentials", async (scope) => {
    // Test invalid resource-level credentials only
    try {
      const vpcName = `${BRANCH_PREFIX}-invalid-creds-vpc`;

      // Create a resource with invalid credential overrides
      // @ts-expect-error - Intentionally passing invalid types for testing
      await Vpc(vpcName, {
        cidrBlock: "10.0.0.0/16",
        region: 123, // Should be a string
        profile: true, // Should be a string
        tags: { Name: vpcName },
      });

      // If we get here, the test failed
      throw new Error(
        "Expected an error for invalid resource-level credentials",
      );
    } catch (error: any) {
      // Verify the error message is helpful
      expect(error.message).toContain(
        "Invalid AWS configuration in resource properties",
      );
    }
  });
});
