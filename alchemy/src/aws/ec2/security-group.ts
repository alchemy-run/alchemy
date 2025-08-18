import type { AwsClient } from "aws4fetch";
import { XMLParser } from "fast-xml-parser";
import type { Context } from "../../context.ts";
import { Resource } from "../../resource.ts";
import { ignore } from "../../util/ignore.ts";
import {
  mergeTimeoutConfig,
  type TimeoutConfig,
  waitForResourceState,
} from "../../util/timeout.ts";
import type { AwsClientProps } from "../client-props.ts";
import { callEC2Api, createEC2Client } from "./utils.ts";
import type { Vpc } from "./vpc.ts";

/**
 * Security Group timeout constants
 */
export const SECURITY_GROUP_TIMEOUT: TimeoutConfig = {
  maxAttempts: 30,
  delayMs: 1000, // 1 second - Security Groups are fast resources
};

/**
 * Properties for creating or updating a Security Group
 */
export interface SecurityGroupProps extends AwsClientProps {
  /**
   * The VPC to create the security group in.
   */
  vpc: Vpc | string;

  /**
   * The name of the security group.
   */
  groupName: string;

  /**
   * The description of the security group.
   */
  description: string;

  /**
   * Tags to apply to the security group.
   */
  tags?: Record<string, string>;

  /**
   * Timeout configuration for Security Group operations.
   * @default Security Group-specific sensible defaults (30 attempts, 1000ms delay)
   */
  timeout?: Partial<TimeoutConfig>;
}

/**
 * Output returned after Security Group creation/update
 */
export interface SecurityGroup
  extends Resource<"aws::SecurityGroup">,
    SecurityGroupProps {
  /**
   * The ID of the security group.
   */
  groupId: string;

  /**
   * The ID of the VPC the security group belongs to.
   */
  vpcId: string;

  /**
   * The AWS account ID that owns the security group.
   */
  ownerId: string;
}

/**
 * AWS Security Group Resource
 *
 * Creates and manages security groups. Acts as a virtual firewall for EC2
 * instances and other AWS resources. Rules are managed separately using the
 * `SecurityGroupRule` resource.
 *
 * Supports AWS credential overrides at the resource level, allowing you to deploy Security Groups
 * to different AWS accounts or regions than the default scope configuration.
 *
 * @example
 * ```typescript
 * // Create a basic web server security group
 * const webSecurityGroup = await SecurityGroup("web-sg", {
 *   vpc: mainVpc,
 *   groupName: "web-server-sg",
 *   description: "Security group for web servers",
 *   tags: {
 *     Name: "web-server-security-group",
 *     Environment: "production"
 *   }
 * });
 * ```
 *
 * @example
 * ```typescript
 * // Create Security Group with AWS credential overrides
 * const crossAccountSg = await SecurityGroup("cross-account-sg", {
 *   vpc: mainVpc,
 *   groupName: "cross-account-security-group",
 *   description: "Security group in different account",
 *   // Override AWS credentials for this specific resource
 *   region: "us-east-1",
 *   profile: "production-account",
 *   tags: {
 *     Name: "cross-account-sg",
 *     Environment: "production"
 *   }
 * });
 * ```
 *
 * @example
 * ```typescript
 * // Create Security Group in different region with role assumption
 * const multiRegionSg = await SecurityGroup("multi-region-sg", {
 *   vpc: euVpc,
 *   groupName: "eu-security-group",
 *   description: "Security group in EU region",
 *   region: "eu-west-1",
 *   roleArn: "arn:aws:iam::123456789012:role/CrossRegionRole",
 *   roleSessionName: "security-group-deployment",
 *   tags: {
 *     Name: "eu-security-group",
 *     Region: "europe"
 *   }
 * });
 * ```
 *
 * @example
 * ```typescript
 * // Create Security Group with explicit credentials
 * const explicitCredsSg = await SecurityGroup("explicit-creds-sg", {
 *   vpc: testVpc,
 *   groupName: "test-security-group",
 *   description: "Security group with explicit credentials",
 *   accessKeyId: alchemy.secret("AKIAIOSFODNN7EXAMPLE"),
 *   secretAccessKey: alchemy.secret("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"),
 *   region: "us-west-2",
 *   tags: {
 *     Name: "explicit-credentials-sg",
 *     Purpose: "testing"
 *   }
 * });
 * ```
 *
 * @example
 * ```typescript
 * // Create Security Group with rules (rules managed separately)
 * const webSg = await SecurityGroup("web-sg", {
 *   vpc: mainVpc,
 *   groupName: "web-server-sg",
 *   description: "Security group for web servers",
 *   tags: { Name: "web-server-security-group" }
 * });
 *
 * // Separately, define a rule to allow HTTP traffic
 * const httpRule = await SecurityGroupRule("web-sg-http-rule", {
 *   securityGroup: webSg,
 *   type: "ingress",
 *   protocol: "tcp",
 *   fromPort: 80,
 *   toPort: 80,
 *   cidrBlocks: ["0.0.0.0/0"],
 *   description: "Allow HTTP access from anywhere"
 * });
 * ```
 *
 * @example
 * ```typescript
 * // Multi-account deployment with scope-level and resource-level overrides
 * await alchemy.run("production", {
 *   aws: { region: "us-west-2", profile: "main-account" }
 * }, async () => {
 *   // This SG uses scope credentials (main-account, us-west-2)
 *   const mainSg = await SecurityGroup("main-sg", {
 *     vpc: mainVpc,
 *     groupName: "main-account-sg",
 *     description: "Security group in main account",
 *     tags: { Name: "main-account-sg" }
 *   });
 *
 *   // This SG overrides to use different account
 *   const crossAccountSg = await SecurityGroup("cross-account-sg", {
 *     vpc: crossVpc,
 *     groupName: "secondary-account-sg",
 *     description: "Security group in secondary account",
 *     profile: "secondary-account",
 *     region: "us-east-1", // Also override region
 *     tags: { Name: "secondary-account-sg" }
 *   });
 * });
 * ```
 */
export const SecurityGroup = Resource(
  "aws::SecurityGroup",
  async function (
    this: Context<SecurityGroup>,
    _id: string,
    props: SecurityGroupProps,
  ): Promise<SecurityGroup> {
    // Create EC2 client with credential resolution handled internally
    const client = await createEC2Client(props);
    const vpcId = typeof props.vpc === "string" ? props.vpc : props.vpc.vpcId;
    const timeoutConfig = mergeTimeoutConfig(
      SECURITY_GROUP_TIMEOUT,
      props.timeout,
    );

    if (this.phase === "delete") {
      if (this.output?.groupId) {
        console.log(`🗑️ Deleting Security Group: ${this.output.groupId}`);
        await ignore(
          ["InvalidGroupId.NotFound", "DependencyViolation"],
          async () => {
            await callEC2Api(
              client,
              "DeleteSecurityGroup",
              parseSecurityGroupXmlResponse,
              {
                GroupId: this.output!.groupId,
              },
            );
          },
        );
        await waitForSecurityGroupDeleted(
          client,
          this.output.groupId,
          timeoutConfig,
        );
        console.log(
          `  ✅ Security Group ${this.output.groupId} deletion completed`,
        );
      }
      return this.destroy();
    }

    let securityGroup: AwsSecurityGroup;

    if (this.phase === "update" && this.output?.groupId) {
      // Get existing security group
      const response = await callEC2Api<DescribeSecurityGroupsResponse>(
        client,
        "DescribeSecurityGroups",
        parseSecurityGroupXmlResponse,
        {
          "GroupId.1": this.output.groupId,
        },
      );

      if (!response.SecurityGroups?.[0]) {
        throw new Error(`Security Group ${this.output.groupId} not found`);
      }
      securityGroup = response.SecurityGroups[0];
    } else {
      // Create new security group
      const createParams: CreateSecurityGroupParams = {
        GroupName: props.groupName,
        GroupDescription: props.description,
        VpcId: vpcId,
      };

      // Add tags if specified
      if (props.tags) {
        createParams.TagSpecifications = [
          {
            ResourceType: "security-group",
            Tags: Object.entries(props.tags).map(([Key, Value]) => ({
              Key,
              Value,
            })),
          },
        ];
      }

      const response = await callEC2Api<CreateSecurityGroupResponse>(
        client,
        "CreateSecurityGroup",
        parseSecurityGroupXmlResponse,
        convertCreateSecurityGroupParamsToAwsFormat(createParams),
      );

      if (!response.GroupId) {
        throw new Error("Failed to create security group");
      }

      // Wait for the security group to be available
      await waitForSecurityGroupAvailable(
        client,
        response.GroupId,
        timeoutConfig,
      );

      // Get the full security group details
      const sgResponse = await callEC2Api<DescribeSecurityGroupsResponse>(
        client,
        "DescribeSecurityGroups",
        parseSecurityGroupXmlResponse,
        {
          "GroupId.1": response.GroupId,
        },
      );

      if (!sgResponse.SecurityGroups?.[0]) {
        throw new Error("Failed to retrieve created security group");
      }
      securityGroup = sgResponse.SecurityGroups[0];
    }

    return this({
      groupId: securityGroup.GroupId,
      vpcId: securityGroup.VpcId,
      ownerId: securityGroup.OwnerId,
      ...props,
      vpc: vpcId,
    });
  },
);

// --- Helper Functions and Interfaces ---

/**
 * AWS Security Group API response types
 */
interface AwsSecurityGroup {
  GroupId: string;
  GroupName: string;
  Description: string;
  VpcId: string;
  OwnerId: string;
}

interface CreateSecurityGroupResponse {
  GroupId: string;
}

interface DescribeSecurityGroupsResponse {
  SecurityGroups: AwsSecurityGroup[];
}

/**
 * Raw XML parsing interfaces for type safety
 */
interface RawSecurityGroupXmlItem {
  groupId: string;
  groupName: string;
  groupDescription: string;
  vpcId: string;
  ownerId: string;
}

/**
 * API Parameter types
 */
interface TagSpecification {
  ResourceType: string;
  Tags: Array<{ Key: string; Value: string }>;
}

interface CreateSecurityGroupParams {
  GroupName: string;
  GroupDescription: string;
  VpcId: string;
  TagSpecifications?: TagSpecification[];
  DryRun?: boolean;
}

/**
 * Parse XML responses specifically for Security Group operations
 */
function parseSecurityGroupXmlResponse<T>(xmlText: string): T {
  const parser = new XMLParser({
    ignoreAttributes: true,
    parseAttributeValue: true,
    parseTagValue: true,
    trimValues: true,
  });

  const parsed = parser.parse(xmlText);
  const result: Record<string, unknown> = {};

  if (parsed.CreateSecurityGroupResponse) {
    result.GroupId = parsed.CreateSecurityGroupResponse.groupId;
  }

  if (parsed.DescribeSecurityGroupsResponse) {
    const securityGroupSet =
      parsed.DescribeSecurityGroupsResponse.securityGroupInfo;
    if (securityGroupSet?.item) {
      const securityGroups = Array.isArray(securityGroupSet.item)
        ? securityGroupSet.item
        : [securityGroupSet.item];
      result.SecurityGroups = securityGroups.map(
        (sg: RawSecurityGroupXmlItem) => ({
          GroupId: sg.groupId,
          GroupName: sg.groupName,
          Description: sg.groupDescription,
          VpcId: sg.vpcId,
          OwnerId: sg.ownerId,
        }),
      );
    } else {
      result.SecurityGroups = [];
    }
  }

  if (parsed.DeleteSecurityGroupResponse) {
    result.success = true;
  }

  return result as T;
}

/**
 * Convert CreateSecurityGroupParams to the format required by the AWS API.
 */
function convertCreateSecurityGroupParamsToAwsFormat(
  params: CreateSecurityGroupParams,
): Record<string, string> {
  const awsParams: Record<string, string> = {
    GroupName: params.GroupName,
    GroupDescription: params.GroupDescription,
    VpcId: params.VpcId,
  };

  if (params.DryRun !== undefined) {
    awsParams.DryRun = params.DryRun.toString();
  }

  if (params.TagSpecifications) {
    params.TagSpecifications.forEach((tagSpec, specIndex) => {
      const specNum = specIndex + 1;
      awsParams[`TagSpecification.${specNum}.ResourceType`] =
        tagSpec.ResourceType;
      tagSpec.Tags.forEach((tag, tagIndex) => {
        const tagNum = tagIndex + 1;
        awsParams[`TagSpecification.${specNum}.Tag.${tagNum}.Key`] = tag.Key;
        awsParams[`TagSpecification.${specNum}.Tag.${tagNum}.Value`] =
          tag.Value;
      });
    });
  }

  return awsParams;
}

/**
 * Wait for a security group to become available.
 */
async function waitForSecurityGroupAvailable(
  client: AwsClient,
  groupId: string,
  timeoutConfig: TimeoutConfig,
): Promise<void> {
  const checkFunction = async () => {
    const response = await callEC2Api<DescribeSecurityGroupsResponse>(
      client,
      "DescribeSecurityGroups",
      parseSecurityGroupXmlResponse,
      { "GroupId.1": groupId },
    );
    return response.SecurityGroups?.[0];
  };

  await waitForResourceState(
    checkFunction,
    (sg) => !!sg,
    timeoutConfig,
    groupId,
    "Security Group",
    "to be available",
  );
}

/**
 * Wait for a security group to be deleted.
 */
async function waitForSecurityGroupDeleted(
  client: AwsClient,
  groupId: string,
  timeoutConfig: TimeoutConfig,
): Promise<void> {
  const checkFunction = async () => {
    try {
      const response = await callEC2Api<DescribeSecurityGroupsResponse>(
        client,
        "DescribeSecurityGroups",
        parseSecurityGroupXmlResponse,
        { "GroupId.1": groupId },
      );
      return response.SecurityGroups?.[0];
    } catch (error: any) {
      if (error.code === "InvalidGroup.NotFound") {
        return undefined;
      }
      throw error;
    }
  };

  await waitForResourceState(
    checkFunction,
    (sg) => !sg,
    timeoutConfig,
    groupId,
    "Security Group",
    "to be deleted",
  );
}
