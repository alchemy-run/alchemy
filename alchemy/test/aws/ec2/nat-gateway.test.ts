import { DescribeNatGatewaysCommand, EC2Client } from "@aws-sdk/client-ec2";
import { describe, expect } from "vitest";
import { alchemy } from "../../../src/alchemy.ts";
import { InternetGatewayAttachment } from "../../../src/aws/ec2/internet-gateway-attachment.ts";
import { InternetGateway } from "../../../src/aws/ec2/internet-gateway.ts";
import {
  NAT_GATEWAY_TIMEOUT,
  NatGateway,
} from "../../../src/aws/ec2/nat-gateway.ts";
import { Subnet } from "../../../src/aws/ec2/subnet.ts";
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

describe.skipIf(!process.env.ALL_TESTS)("NatGateway", () => {
  test(
    "create NAT gateway with automatic EIP allocation",
    async (scope) => {
      const vpcName = `${BRANCH_PREFIX}-alchemy-test-nat-vpc`;
      const igwName = `${BRANCH_PREFIX}-alchemy-test-nat-igw`;
      const subnetName = `${BRANCH_PREFIX}-alchemy-test-nat-subnet`;
      const natName = `${BRANCH_PREFIX}-alchemy-test-nat`;

      let vpc: Awaited<ReturnType<typeof Vpc>>;
      let internetGateway: Awaited<ReturnType<typeof InternetGateway>>;
      let _internetGatewayAttachment: Awaited<
        ReturnType<typeof InternetGatewayAttachment>
      >;
      let subnet: Awaited<ReturnType<typeof Subnet>>;
      let natGateway: Awaited<ReturnType<typeof NatGateway>>;

      try {
        console.log("Creating VPC...");
        vpc = await Vpc(vpcName, {
          cidrBlock: "10.0.0.0/16",
          tags: { Name: vpcName },
        });
        console.log(`VPC created: ${vpc.vpcId}`);

        console.log("Creating Internet Gateway...");
        internetGateway = await InternetGateway(igwName, {
          tags: { Name: igwName },
        });
        console.log(
          `Internet Gateway created: ${internetGateway.internetGatewayId}`,
        );

        console.log("Attaching Internet Gateway to VPC...");
        try {
          _internetGatewayAttachment = await InternetGatewayAttachment(
            `${igwName}-attachment`,
            {
              vpc,
              internetGateway,
            },
          );
          console.log("Internet Gateway attached successfully");
        } catch (error) {
          console.error("Failed to attach Internet Gateway:", error);
          throw error;
        }

        console.log("Creating public subnet...");
        subnet = await Subnet(subnetName, {
          vpc,
          cidrBlock: "10.0.1.0/24",
          availabilityZone: process.env.AWS_REGION
            ? `${process.env.AWS_REGION}a`
            : "us-east-1a",
          mapPublicIpOnLaunch: true,
          tags: { Name: subnetName, Type: "public" },
        });
        console.log(`Subnet created: ${subnet.subnetId}`);

        console.log("Creating NAT Gateway...");
        natGateway = await NatGateway(natName, {
          subnet,
          connectivityType: "public",
          tags: {
            Name: natName,
            Environment: "test",
          },
        });
        console.log(`NAT Gateway created: ${natGateway.natGatewayId}`);

        expect(natGateway.natGatewayId).toBeTruthy();
        expect(natGateway.subnetId).toBe(subnet.subnetId);
        expect(natGateway.vpcId).toBe(vpc.vpcId);
        expect(natGateway.allocationId).toBeTruthy();
        expect(natGateway.createdElasticIp).toBe(true);
        expect(natGateway.publicIp).toBeTruthy();

        // Verify NAT gateway exists and is available
        const describeResponse = await ec2.send(
          new DescribeNatGatewaysCommand({
            NatGatewayIds: [natGateway.natGatewayId],
          }),
        );
        const nat = describeResponse.NatGateways?.[0];
        expect(nat?.NatGatewayId).toBe(natGateway.natGatewayId);
        expect(nat?.SubnetId).toBe(subnet.subnetId);
        expect(nat?.VpcId).toBe(vpc.vpcId);
        expect(nat?.State).toBe("available");
      } finally {
        // Always clean up, even if test fails
        console.log("Starting cleanup...");
        await destroy(scope);
        console.log("Cleanup completed!");
      }
    },
    NAT_GATEWAY_TIMEOUT.maxAttempts * NAT_GATEWAY_TIMEOUT.delayMs + 120000, // NAT Gateway timeout + 2min buffer for other resources
  );

  test(
    "create NAT gateway with credential overrides",
    async (scope) => {
      const vpcName = `${BRANCH_PREFIX}-alchemy-test-nat-creds-vpc`;
      const igwName = `${BRANCH_PREFIX}-alchemy-test-nat-creds-igw`;
      const subnetName = `${BRANCH_PREFIX}-alchemy-test-nat-creds-subnet`;
      const natName = `${BRANCH_PREFIX}-alchemy-test-nat-creds`;

      let vpc: Awaited<ReturnType<typeof Vpc>>;
      let internetGateway: Awaited<ReturnType<typeof InternetGateway>>;
      let _internetGatewayAttachment: Awaited<
        ReturnType<typeof InternetGatewayAttachment>
      >;
      let subnet: Awaited<ReturnType<typeof Subnet>>;
      let natGateway: Awaited<ReturnType<typeof NatGateway>>;

      try {
        // Create resources with region override
        vpc = await Vpc(vpcName, {
          cidrBlock: "10.0.0.0/16",
          region: "us-west-2", // Override region
          tags: { Name: vpcName },
        });

        internetGateway = await InternetGateway(igwName, {
          region: "us-west-2", // Override region
          tags: { Name: igwName },
        });

        _internetGatewayAttachment = await InternetGatewayAttachment(
          `${igwName}-attachment`,
          {
            vpc,
            internetGateway,
            region: "us-west-2", // Override region
          },
        );

        subnet = await Subnet(subnetName, {
          vpc,
          cidrBlock: "10.0.1.0/24",
          availabilityZone: "us-west-2a",
          mapPublicIpOnLaunch: true,
          region: "us-west-2", // Override region
          tags: { Name: subnetName, Type: "public" },
        });

        // Create NAT Gateway with explicit region override
        natGateway = await NatGateway(natName, {
          subnet,
          connectivityType: "public",
          region: "us-west-2", // Override region
          tags: {
            Name: natName,
            Environment: "test",
            CredentialTest: "true",
          },
        });

        console.log(`NAT Gateway created with ID: ${natGateway.natGatewayId}`);

        expect(natGateway.natGatewayId).toBeTruthy();
        expect(natGateway.subnetId).toBe(subnet.subnetId);
        expect(natGateway.vpcId).toBe(vpc.vpcId);
        expect(natGateway.allocationId).toBeTruthy();
        expect(natGateway.createdElasticIp).toBe(true);

        // Verify NAT gateway exists in the specified region
        const regionalEc2 = new EC2Client({ region: "us-west-2" });
        const describeResponse = await regionalEc2.send(
          new DescribeNatGatewaysCommand({
            NatGatewayIds: [natGateway.natGatewayId],
          }),
        );
        const nat = describeResponse.NatGateways?.[0];
        expect(nat?.NatGatewayId).toBe(natGateway.natGatewayId);
        expect(nat?.SubnetId).toBe(subnet.subnetId);
        expect(nat?.VpcId).toBe(vpc.vpcId);
        expect(nat?.State).toBe("available");
      } finally {
        // Always clean up, even if test fails
        await destroy(scope);
      }
    },
    NAT_GATEWAY_TIMEOUT.maxAttempts * NAT_GATEWAY_TIMEOUT.delayMs + 120000, // NAT Gateway timeout + 2min buffer for other resources
  );
});
