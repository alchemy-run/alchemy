import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import type {
  SecurityGroup,
  SecurityGroupArn,
  SecurityGroupId,
  SecurityGroupRuleData,
} from "./SecurityGroup.ts";
import type { VpcId } from "./Vpc.ts";

class DefaultSecurityGroupNotFound extends Data.TaggedError(
  "DefaultSecurityGroupNotFound",
)<{ vpcId: VpcId }> {}

/** Properties for a VPC's AWS-created `default` security group. */
export interface DefaultSecurityGroupProps {
  /** The VPC whose AWS-created `default` security group is managed. */
  vpcId: VpcId;

  /**
   * Complete desired inbound rule set. An empty list removes every inbound
   * rule, including AWS's initial self-reference rule.
   */
  ingress: SecurityGroupRuleData[];

  /**
   * Complete desired outbound rule set. An empty list removes every outbound
   * rule, including AWS's initial allow-all rule.
   */
  egress: SecurityGroupRuleData[];
}

export interface DefaultSecurityGroup extends Resource<
  "AWS.EC2.DefaultSecurityGroup",
  DefaultSecurityGroupProps,
  SecurityGroup["Attributes"],
  never,
  Providers
> {}

/**
 * Declaratively manages the rules of the AWS-created `default` security group
 * in one VPC. AWS creates this group named `default` whenever it creates a
 * VPC; Alchemy looks it up by VPC ID and name, never creates it, and never
 * deletes it.
 *
 * `ingress` and `egress` are required complete lists. Passing `[]` closes that
 * direction. Omitting either field is a type error, so this resource never
 * silently retains or restores AWS's permissive default rules. This resource
 * exclusively manages every rule on the group; do not combine it with inline
 * or standalone `SecurityGroupRule` management for the same group.
 *
 * Removing this Alchemy resource leaves both the default group and its last
 * applied rules unchanged. Deleting its VPC removes the group as part of AWS's
 * VPC lifecycle.
 *
 * ### Closing the Default Security Group
 * **Example:** Deny all inbound and outbound traffic
 * ```typescript
 * const vpc = yield* AWS.EC2.Vpc("Vpc", { cidrBlock: "10.0.0.0/16" });
 * yield* AWS.EC2.DefaultSecurityGroup("DefaultSecurityGroup", {
 *   vpcId: vpc.vpcId,
 *   ingress: [],
 *   egress: [],
 * });
 * ```
 *
 * @resource
 */
export const DefaultSecurityGroup = Resource<DefaultSecurityGroup>(
  "AWS.EC2.DefaultSecurityGroup",
);

export const DefaultSecurityGroupProvider = () =>
  Provider.effect(
    DefaultSecurityGroup,
    Effect.gen(function* () {
      const describeGroup = (vpcId: VpcId) =>
        ec2
          .describeSecurityGroups({
            Filters: [
              { Name: "vpc-id", Values: [vpcId] },
              { Name: "group-name", Values: ["default"] },
            ],
          })
          .pipe(
            Effect.flatMap((result) => {
              const group = result.SecurityGroups?.[0];
              return group
                ? Effect.succeed(group)
                : Effect.fail(new DefaultSecurityGroupNotFound({ vpcId }));
            }),
            // A VPC is available before its default group is always visible
            // to DescribeSecurityGroups. This is especially common when both
            // resources are declared in one deployment.
            Effect.retry({
              while: (error) => error._tag === "DefaultSecurityGroupNotFound",
              schedule: Schedule.max([
                Schedule.fixed("1 second"),
                Schedule.recurs(10),
              ]),
            }),
          );

      const describeRules = (groupId: SecurityGroupId) =>
        ec2.describeSecurityGroupRules
          .items({ Filters: [{ Name: "group-id", Values: [groupId] }] })
          .pipe(
            Stream.runCollect,
            Effect.map((rules) => Array.from(rules)),
          );

      const toAttrs = Effect.fn(function* (
        group: ec2.SecurityGroup,
        rules: ec2.SecurityGroupRule[],
      ) {
        const { accountId, region } = yield* AWSEnvironment.current;
        const toRule =
          <IsEgress extends boolean>(isEgress: IsEgress) =>
          (rule: ec2.SecurityGroupRule) => ({
            securityGroupRuleId: rule.SecurityGroupRuleId!,
            ipProtocol: rule.IpProtocol!,
            fromPort: rule.FromPort,
            toPort: rule.ToPort,
            cidrIpv4: rule.CidrIpv4,
            cidrIpv6: rule.CidrIpv6,
            referencedGroupId: rule.ReferencedGroupInfo?.GroupId,
            prefixListId: rule.PrefixListId,
            description: rule.Description,
            isEgress,
          });
        return {
          groupId: group.GroupId as SecurityGroupId,
          groupArn:
            `arn:aws:ec2:${region}:${accountId}:security-group/${group.GroupId}` as SecurityGroupArn,
          groupName: group.GroupName!,
          description: group.Description!,
          vpcId: group.VpcId as VpcId,
          ownerId: group.OwnerId!,
          ingressRules: rules
            .filter((rule) => !rule.IsEgress)
            .map(toRule(false)),
          egressRules: rules.filter((rule) => rule.IsEgress).map(toRule(true)),
        } satisfies DefaultSecurityGroup["Attributes"];
      });

      const toPermission = (rule: SecurityGroupRuleData): ec2.IpPermission => ({
        IpProtocol: rule.ipProtocol,
        FromPort: rule.fromPort,
        ToPort: rule.toPort,
        IpRanges: rule.cidrIpv4
          ? [{ CidrIp: rule.cidrIpv4, Description: rule.description }]
          : undefined,
        Ipv6Ranges: rule.cidrIpv6
          ? [{ CidrIpv6: rule.cidrIpv6, Description: rule.description }]
          : undefined,
        UserIdGroupPairs: rule.referencedGroupId
          ? [{ GroupId: rule.referencedGroupId, Description: rule.description }]
          : undefined,
        PrefixListIds: rule.prefixListId
          ? [{ PrefixListId: rule.prefixListId, Description: rule.description }]
          : undefined,
      });

      return {
        stables: ["groupId", "groupArn", "groupName", "ownerId"],

        read: Effect.fn(function* ({ output }) {
          if (!output) return undefined;
          const group = yield* describeGroup(output.vpcId);
          return yield* toAttrs(
            group,
            yield* describeRules(group.GroupId as SecurityGroupId),
          );
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (isResolved(news) && news.vpcId !== olds.vpcId) {
            return { action: "replace" };
          }
        }),

        reconcile: Effect.fn(function* ({ news, session }) {
          const group = yield* describeGroup(news.vpcId);
          const groupId = group.GroupId as SecurityGroupId;
          const rules = yield* describeRules(groupId);
          const ingress = rules.filter((rule) => !rule.IsEgress);
          const egress = rules.filter((rule) => rule.IsEgress);

          if (ingress.length > 0) {
            yield* ec2
              .revokeSecurityGroupIngress({
                GroupId: groupId,
                SecurityGroupRuleIds: ingress.map(
                  (rule) => rule.SecurityGroupRuleId!,
                ),
                DryRun: false,
              })
              .pipe(
                Effect.catchTag(
                  "InvalidPermission.NotFound",
                  () => Effect.void,
                ),
              );
          }
          if (egress.length > 0) {
            yield* ec2
              .revokeSecurityGroupEgress({
                GroupId: groupId,
                SecurityGroupRuleIds: egress.map(
                  (rule) => rule.SecurityGroupRuleId!,
                ),
                DryRun: false,
              })
              .pipe(
                Effect.catchTag(
                  "InvalidPermission.NotFound",
                  () => Effect.void,
                ),
              );
          }
          if (news.ingress.length > 0) {
            yield* ec2.authorizeSecurityGroupIngress({
              GroupId: groupId,
              IpPermissions: news.ingress.map(toPermission),
              DryRun: false,
            });
          }
          if (news.egress.length > 0) {
            yield* ec2.authorizeSecurityGroupEgress({
              GroupId: groupId,
              IpPermissions: news.egress.map(toPermission),
              DryRun: false,
            });
          }
          yield* session.note(`Reconciled default security group: ${groupId}`);
          const finalGroup = yield* describeGroup(news.vpcId);
          return yield* toAttrs(finalGroup, yield* describeRules(groupId));
        }),

        // AWS owns the default group. Intentionally leave it and its rules as-is.
        delete: () => Effect.void,
      };
    }),
  );
