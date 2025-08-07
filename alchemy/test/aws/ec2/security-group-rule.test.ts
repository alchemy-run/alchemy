import { DescribeSecurityGroupsCommand, EC2Client } from "@aws-sdk/client-ec2";
import { describe, expect } from "vitest";
import { alchemy } from "../../../src/alchemy.ts";
import { SecurityGroupRule } from "../../../src/aws/ec2/security-group-rule.ts";
import { SecurityGroup } from "../../../src/aws/ec2/security-group.ts";
import { Vpc } from "../../../src/aws/ec2/vpc.ts";
import { destroy } from "../../../src/destroy.ts";
import { BRANCH_PREFIX } from "../../util.ts";

import "../../../src/test/vitest.ts";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

const ec2 = new EC2Client({});

describe.skipIf(!process.env.ALL_TESTS)("SecurityGroupRule", () => {
  test("create security group with ingress rules", async (scope) => {
    const vpcName = `${BRANCH_PREFIX}-alchemy-test-sgr-vpc`;
    const sgName = `${BRANCH_PREFIX}-alchemy-test-sgr`;
    let vpc: Awaited<ReturnType<typeof Vpc>>;
    let securityGroup: Awaited<ReturnType<typeof SecurityGroup>>;

    try {
      // First create a VPC and a Security Group
      vpc = await Vpc(vpcName, {
        cidrBlock: "10.0.0.0/16",
        tags: { Name: vpcName },
      });

      securityGroup = await SecurityGroup(sgName, {
        vpc,
        groupName: sgName,
        description: "Test security group for Alchemy Rules",
        tags: {
          Name: sgName,
        },
      });

      // Add ingress rules to the security group
      await SecurityGroupRule(`${sgName}-http`, {
        securityGroup,
        type: "ingress",
        protocol: "tcp",
        fromPort: 80,
        toPort: 80,
        cidrBlocks: ["0.0.0.0/0"],
        description: "HTTP access",
      });

      await SecurityGroupRule(`${sgName}-https`, {
        securityGroup,
        type: "ingress",
        protocol: "tcp",
        fromPort: 443,
        toPort: 443,
        cidrBlocks: ["0.0.0.0/0"],
        description: "HTTPS access",
      });

      // Verify security group rules exist
      const describeResponse = await ec2.send(
        new DescribeSecurityGroupsCommand({
          GroupIds: [securityGroup.groupId],
        }),
      );
      const sg = describeResponse.SecurityGroups?.[0];
      expect(sg?.IpPermissions?.length).toBe(2);

      const httpRule = sg?.IpPermissions?.find((p) => p.FromPort === 80);
      expect(httpRule?.IpProtocol).toBe("tcp");
      expect(httpRule?.ToPort).toBe(80);
      expect(httpRule?.IpRanges?.[0]?.CidrIp).toBe("0.0.0.0/0");
      expect(httpRule?.IpRanges?.[0]?.Description).toBe("HTTP access");

      const httpsRule = sg?.IpPermissions?.find((p) => p.FromPort === 443);
      expect(httpsRule?.IpProtocol).toBe("tcp");
      expect(httpsRule?.ToPort).toBe(443);
      expect(httpsRule?.IpRanges?.[0]?.CidrIp).toBe("0.0.0.0/0");
      expect(httpsRule?.IpRanges?.[0]?.Description).toBe("HTTPS access");
    } finally {
      // Always clean up, even if test fails
      await destroy(scope);
    }
  });
});
