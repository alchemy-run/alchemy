import { DescribeSecurityGroupsCommand, EC2Client } from "@aws-sdk/client-ec2";
import { describe, expect } from "vitest";
import { alchemy } from "../../../src/alchemy.ts";
import { SecurityGroup } from "../../../src/aws/ec2/security-group.ts";
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

describe.skipIf(!process.env.ALL_TESTS)("SecurityGroup", () => {
  test("create security group", async (scope) => {
    const vpcName = `${BRANCH_PREFIX}-alchemy-test-sg-vpc`;
    const sgName = `${BRANCH_PREFIX}-alchemy-test-sg`;
    let vpc: Awaited<ReturnType<typeof Vpc>>;
    let securityGroup: Awaited<ReturnType<typeof SecurityGroup>>;

    try {
      // First create a VPC
      vpc = await Vpc(vpcName, {
        cidrBlock: "10.0.0.0/16",
        tags: { Name: vpcName },
      });

      securityGroup = await SecurityGroup(sgName, {
        vpc,
        groupName: sgName,
        description: "Test security group for Alchemy",
        tags: {
          Name: sgName,
          Environment: "test",
        },
      });

      expect(securityGroup.groupId).toBeTruthy();
      expect(securityGroup.vpcId).toBe(vpc.vpcId);
      expect(securityGroup.groupName).toBe(sgName);
      expect(securityGroup.description).toBe("Test security group for Alchemy");

      // Verify security group exists
      const describeResponse = await ec2.send(
        new DescribeSecurityGroupsCommand({
          GroupIds: [securityGroup.groupId],
        }),
      );
      const sg = describeResponse.SecurityGroups?.[0];
      expect(sg?.GroupName).toBe(sgName);
      expect(sg?.VpcId).toBe(vpc.vpcId);
    } finally {
      // Always clean up, even if test fails
      await destroy(scope);
    }
  });

  test("create security group with credential overrides", async (scope) => {
    const vpcName = `${BRANCH_PREFIX}-alchemy-test-sg-creds-vpc`;
    const sgName = `${BRANCH_PREFIX}-alchemy-test-sg-creds`;
    let vpc: Awaited<ReturnType<typeof Vpc>>;
    let securityGroup: Awaited<ReturnType<typeof SecurityGroup>>;

    try {
      // First create a VPC with region override
      vpc = await Vpc(vpcName, {
        cidrBlock: "10.0.0.0/16",
        region: "us-west-2", // Override region
        tags: { Name: vpcName },
      });

      // Create Security Group with explicit region override
      securityGroup = await SecurityGroup(sgName, {
        vpc,
        groupName: sgName,
        description: "Test security group with credential overrides",
        region: "us-west-2", // Override region
        tags: {
          Name: sgName,
          Environment: "test",
          CredentialTest: "true",
        },
      });

      expect(securityGroup.groupId).toBeTruthy();
      expect(securityGroup.vpcId).toBe(vpc.vpcId);
      expect(securityGroup.groupName).toBe(sgName);

      // Verify security group exists in the specified region
      const regionalEc2 = new EC2Client({ region: "us-west-2" });
      const describeResponse = await regionalEc2.send(
        new DescribeSecurityGroupsCommand({
          GroupIds: [securityGroup.groupId],
        }),
      );
      const sg = describeResponse.SecurityGroups?.[0];
      expect(sg?.GroupName).toBe(sgName);
      expect(sg?.VpcId).toBe(vpc.vpcId);
    } finally {
      // Always clean up, even if test fails
      await destroy(scope);
    }
  });

  test("create security group with profile override", async (scope) => {
    const vpcName = `${BRANCH_PREFIX}-alchemy-test-sg-profile-vpc`;
    const sgName = `${BRANCH_PREFIX}-alchemy-test-sg-profile`;
    let vpc: Awaited<ReturnType<typeof Vpc>>;
    let securityGroup: Awaited<ReturnType<typeof SecurityGroup>>;

    try {
      // First create a VPC with profile override
      vpc = await Vpc(vpcName, {
        cidrBlock: "10.0.0.0/16",
        profile: process.env.AWS_PROFILE || "default", // Override profile
        region: "us-west-2",
        tags: { Name: vpcName },
      });

      // Create Security Group with profile override
      securityGroup = await SecurityGroup(sgName, {
        vpc,
        groupName: sgName,
        description: "Test security group with profile override",
        profile: process.env.AWS_PROFILE || "default", // Override profile
        region: "us-west-2",
        tags: {
          Name: sgName,
          Environment: "test",
          ProfileTest: "true",
        },
      });

      expect(securityGroup.groupId).toBeTruthy();
      expect(securityGroup.vpcId).toBe(vpc.vpcId);
      expect(securityGroup.groupName).toBe(sgName);

      // Verify security group exists
      const describeResponse = await ec2.send(
        new DescribeSecurityGroupsCommand({
          GroupIds: [securityGroup.groupId],
        }),
      );
      const sg = describeResponse.SecurityGroups?.[0];
      expect(sg?.GroupName).toBe(sgName);
      expect(sg?.VpcId).toBe(vpc.vpcId);
    } finally {
      // Always clean up, even if test fails
      await destroy(scope);
    }
  });
});
