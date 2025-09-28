import { XMLParser } from "fast-xml-parser";
import type { Context } from "../../context.ts";
import { Resource } from "../../resource.ts";
import { ignore } from "../../util/ignore.ts";
import type { SecurityGroup } from "./security-group.ts";
import { callEC2Api, createEC2Client } from "./utils.ts";

/**
 * Properties for creating or updating a Security Group Rule
 */
export interface SecurityGroupRuleProps {
  /**
   * The security group to apply the rule to.
   */
  securityGroup: SecurityGroup | string;

  /**
   * The type of rule, either 'ingress' (inbound) or 'egress' (outbound).
   */
  type: "ingress" | "egress";

  /**
   * The IP protocol name (tcp, udp, icmp, icmpv6) or number.
   * Use '-1' to specify all protocols.
   */
  protocol: string;

  /**
   * The start of the port range for the rule.
   * For ICMP, this is the ICMP type number. A value of -1 indicates all types.
   */
  fromPort: number;

  /**
   * The end of the port range for the rule.
   * For ICMP, this is the ICMP code. A value of -1 indicates all codes.
   */
  toPort: number;

  /**
   * The IPv4 CIDR ranges to allow.
   */
  cidrBlocks?: string[];

  /**
   * The source security group IDs to allow.
   */
  sourceSecurityGroups?: (SecurityGroup | string)[];

  /**
   * A description for the rule.
   */
  description?: string;
}

/**
 * Output returned after Security Group Rule creation/update
 */
export interface SecurityGroupRule extends SecurityGroupRuleProps {
  /**
   * A unique identifier for the rule resource.
   */
  ruleId: string;
}

/**
 * AWS Security Group Rule Resource
 *
 * Manages a single ingress or egress rule for a security group.
 *
 * @example
 * // A rule to allow HTTP traffic from anywhere
 * const httpRule = await SecurityGroupRule("web-sg-http-rule", {
 *   securityGroup: webSecurityGroup,
 *   type: "ingress",
 *   protocol: "tcp",
 *   fromPort: 80,
 *   toPort: 80,
 *   cidrBlocks: ["0.0.0.0/0"],
 *   description: "Allow HTTP access from anywhere"
 * });
 *
 * @example
 * // A rule to allow a database security group to receive traffic
 * // from a web server security group on the MySQL port.
 * const dbAccessRule = await SecurityGroupRule("db-access-from-web", {
 *   securityGroup: dbSecurityGroup,
 *   type: "ingress",
 *   protocol: "tcp",
 *   fromPort: 3306,
 *   toPort: 3306,
 *   sourceSecurityGroups: [webSecurityGroup],
 *   description: "Allow MySQL access from web servers"
 * });
 */
export const SecurityGroupRule = Resource(
  "aws::SecurityGroupRule",
  async function (
    this: Context<SecurityGroupRule>,
    _id: string,
    props: SecurityGroupRuleProps,
  ): Promise<SecurityGroupRule> {
    const client = await createEC2Client();
    const groupId =
      typeof props.securityGroup === "string"
        ? props.securityGroup
        : props.securityGroup.groupId;

    // A deterministic ID for the rule based on its properties
    const ruleId = `${groupId}-${props.type}-${props.protocol}-${
      props.fromPort
    }-${props.toPort}-${(props.cidrBlocks || []).join("-")}-${(
      props.sourceSecurityGroups || []
    )
      .map((sg) => (typeof sg === "string" ? sg : sg.groupId))
      .join("-")}`;

    if (this.phase === "delete") {
      const revokeParams = convertRuleToApiParams(props, groupId);
      const action =
        props.type === "ingress"
          ? "RevokeSecurityGroupIngress"
          : "RevokeSecurityGroupEgress";

      // Ignore errors if the rule doesn't exist, as it's already deleted.
      await ignore("InvalidPermission.NotFound", async () => {
        await callEC2Api(
          client,
          action,
          parseSecurityGroupRuleXmlResponse,
          revokeParams,
        );
      });

      return this.destroy();
    }

    // For both create and update, we authorize the rule.
    // The resource framework handles replacement by calling delete then create.
    // The AuthorizeSecurityGroup* API calls are idempotent, so calling this on
    // an existing rule will not cause an error.
    const authorizeParams = convertRuleToApiParams(props, groupId);
    const action =
      props.type === "ingress"
        ? "AuthorizeSecurityGroupIngress"
        : "AuthorizeSecurityGroupEgress";

    // There is no "pending" state for a security group rule. The API call
    // is synchronous, and success is determined by the response.
    await callEC2Api(
      client,
      action,
      parseSecurityGroupRuleXmlResponse,
      authorizeParams,
    );

    return {
      ruleId,
      ...props,
    };
  },
);

// --- Helper Functions and Interfaces ---
/**
 * Parse XML responses for Security Group Rule operations
 */
function parseSecurityGroupRuleXmlResponse<T>(xmlText: string): T {
  const parser = new XMLParser({
    ignoreAttributes: true,
    parseAttributeValue: true,
    parseTagValue: true,
  });
  const parsed = parser.parse(xmlText);
  const result: Record<string, unknown> = {};

  if (
    parsed.AuthorizeSecurityGroupIngressResponse ||
    parsed.AuthorizeSecurityGroupEgressResponse ||
    parsed.RevokeSecurityGroupIngressResponse ||
    parsed.RevokeSecurityGroupEgressResponse
  ) {
    result.success = parsed.return === "true" || parsed.return === true;
  }

  return result as T;
}

/**
 * Convert rule properties to the flat format required by the AWS API.
 */
function convertRuleToApiParams(
  props: SecurityGroupRuleProps,
  groupId: string,
): Record<string, string> {
  const params: Record<string, string> = {
    GroupId: groupId,
    "IpPermissions.1.IpProtocol": props.protocol,
    "IpPermissions.1.FromPort": props.fromPort.toString(),
    "IpPermissions.1.ToPort": props.toPort.toString(),
  };

  const prefix = "IpPermissions.1";

  if (props.cidrBlocks && props.cidrBlocks.length > 0) {
    props.cidrBlocks.forEach((cidr, index) => {
      const rangePrefix = `${prefix}.IpRanges.${index + 1}`;
      params[`${rangePrefix}.CidrIp`] = cidr;
      if (props.description) {
        params[`${rangePrefix}.Description`] = props.description;
      }
    });
  }

  if (props.sourceSecurityGroups && props.sourceSecurityGroups.length > 0) {
    props.sourceSecurityGroups.forEach((sg, index) => {
      const groupPrefix = `${prefix}.UserIdGroupPairs.${index + 1}`;
      params[`${groupPrefix}.GroupId`] =
        typeof sg === "string" ? sg : sg.groupId;
      if (props.description) {
        params[`${groupPrefix}.Description`] = props.description;
      }
    });
  }

  return params;
}
