import * as EC2 from "itty-aws/ec2";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

import { createPhysicalName } from "../../physical-name.ts";
import { createTagger, createTagsList, diffTags } from "../../tags.ts";
import { Account } from "../account.ts";
import { Region } from "../region.ts";
import { EC2Client } from "./client.ts";
import {
  type SecurityGroupArn,
  type SecurityGroupRuleData,
  SecurityGroup,
  type SecurityGroupAttrs,
  type SecurityGroupId,
} from "./security-group.ts";
import type { VpcId } from "./vpc.ts";

export const securityGroupProvider = () =>
  SecurityGroup.provider.effect(
    Effect.gen(function* () {
      const ec2 = yield* EC2Client;
      const region = yield* Region;
      const accountId = yield* Account;
      const tagged = yield* createTagger();

      const createTags = (
        id: string,
        tags?: Record<string, string>,
      ): Record<string, string> => ({
        Name: id,
        ...tagged(id),
        ...tags,
      });

      const createGroupName = (id: string, name: string | undefined) =>
        Effect.gen(function* () {
          if (name) return name;
          return yield* createPhysicalName({ id, maxLength: 255 });
        });

      const describeSecurityGroup = (groupId: string) =>
        ec2.describeSecurityGroups({ GroupIds: [groupId] }).pipe(
          Effect.map((r) => r.SecurityGroups?.[0]),
          Effect.flatMap((sg) =>
            sg
              ? Effect.succeed(sg)
              : Effect.fail(new Error(`Security Group ${groupId} not found`)),
          ),
        );

      const describeSecurityGroupRules = (groupId: string) =>
        ec2.describeSecurityGroupRules({
          Filters: [{ Name: "group-id", Values: [groupId] }],
        });

      const toAttrs = (
        sg: EC2.SecurityGroup,
        rules: EC2.SecurityGroupRule[],
      ): SecurityGroupAttrs => ({
        groupId: sg.GroupId as SecurityGroupId,
        groupArn:
          `arn:aws:ec2:${region}:${accountId}:security-group/${sg.GroupId as SecurityGroupId}` as SecurityGroupArn,
        groupName: sg.GroupName!,
        description: sg.Description!,
        vpcId: sg.VpcId as VpcId,
        ownerId: sg.OwnerId!,
        ingressRules: rules
          .filter((r) => !r.IsEgress)
          .map((r) => ({
            securityGroupRuleId: r.SecurityGroupRuleId!,
            ipProtocol: r.IpProtocol!,
            fromPort: r.FromPort,
            toPort: r.ToPort,
            cidrIpv4: r.CidrIpv4,
            cidrIpv6: r.CidrIpv6,
            referencedGroupId: r.ReferencedGroupInfo?.GroupId,
            prefixListId: r.PrefixListId,
            description: r.Description,
            isEgress: false as const,
          })),
        egressRules: rules
          .filter((r) => r.IsEgress)
          .map((r) => ({
            securityGroupRuleId: r.SecurityGroupRuleId!,
            ipProtocol: r.IpProtocol!,
            fromPort: r.FromPort,
            toPort: r.ToPort,
            cidrIpv4: r.CidrIpv4,
            cidrIpv6: r.CidrIpv6,
            referencedGroupId: r.ReferencedGroupInfo?.GroupId,
            prefixListId: r.PrefixListId,
            description: r.Description,
            isEgress: true as const,
          })),
      });

      const toIpPermission = (
        rule: SecurityGroupRuleData,
      ): EC2.IpPermission => ({
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
          ? [
              {
                GroupId: rule.referencedGroupId as string,
                Description: rule.description,
              },
            ]
          : undefined,
        PrefixListIds: rule.prefixListId
          ? [
              {
                PrefixListId: rule.prefixListId as string,
                Description: rule.description,
              },
            ]
          : undefined,
      });

      return {
        stables: ["groupId", "groupArn", "ownerId"],

        read: Effect.fn(function* ({ output }) {
          if (!output) return undefined;
          const sg = yield* describeSecurityGroup(output.groupId);
          const rulesResult = yield* describeSecurityGroupRules(output.groupId);
          return toAttrs(sg, rulesResult.SecurityGroupRules ?? []);
        }),

        diff: Effect.fn(function* ({ id, news, olds, output }) {
          // VPC change requires replacement
          if (news.vpcId !== olds.vpcId) {
            return { action: "replace" };
          }

          // Group name change requires replacement
          const newGroupName = yield* createGroupName(id, news.groupName);
          if (newGroupName !== output.groupName) {
            return { action: "replace" };
          }

          // Other changes can be updated in-place
        }),

        create: Effect.fn(function* ({ id, news, session }) {
          const groupName = yield* createGroupName(id, news.groupName);

          yield* session.note(`Creating Security Group: ${groupName}`);

          const result = yield* ec2.createSecurityGroup({
            GroupName: groupName,
            Description: news.description ?? "Managed by Alchemy",
            VpcId: news.vpcId as string,
            TagSpecifications: [
              {
                ResourceType: "security-group",
                Tags: createTagsList(createTags(id, news.tags)),
              },
            ],
            DryRun: false,
          });

          const groupId = result.GroupId! as SecurityGroupId;
          yield* session.note(`Security Group created: ${groupId}`);

          // Revoke the default egress rule if we have custom egress rules
          if (news.egress && news.egress.length > 0) {
            yield* ec2
              .revokeSecurityGroupEgress({
                GroupId: groupId,
                IpPermissions: [
                  {
                    IpProtocol: "-1",
                    IpRanges: [{ CidrIp: "0.0.0.0/0" }],
                  },
                ],
                DryRun: false,
              })
              .pipe(
                Effect.catchTag(
                  "InvalidPermission.NotFound",
                  () => Effect.void,
                ),
              );
          }

          // Add ingress rules
          if (news.ingress && news.ingress.length > 0) {
            yield* ec2.authorizeSecurityGroupIngress({
              GroupId: groupId,
              IpPermissions: news.ingress.map(toIpPermission),
              DryRun: false,
            });
            yield* session.note(`Added ${news.ingress.length} ingress rules`);
          }

          // Add egress rules
          if (news.egress && news.egress.length > 0) {
            yield* ec2.authorizeSecurityGroupEgress({
              GroupId: groupId,
              IpPermissions: news.egress.map(toIpPermission),
              DryRun: false,
            });
            yield* session.note(`Added ${news.egress.length} egress rules`);
          }

          // Fetch the final state
          const sg = yield* describeSecurityGroup(groupId);
          const rulesResult = yield* describeSecurityGroupRules(groupId);
          return toAttrs(sg, rulesResult.SecurityGroupRules ?? []);
        }),

        update: Effect.fn(function* ({ id, news, olds, output, session }) {
          const groupId = output.groupId;

          // Handle description update (requires modifying the group)
          if (news.description !== olds.description) {
            yield* ec2.modifySecurityGroupRules({
              GroupId: groupId,
              // Description can't actually be changed after creation in EC2
              // This is a no-op but we log it
              SecurityGroupRules: [],
            });
          }

          // Handle tag updates
          const newTags = createTags(id, news.tags);
          const oldTags =
            (yield* ec2
              .describeTags({
                Filters: [
                  { Name: "resource-id", Values: [groupId] },
                  { Name: "resource-type", Values: ["security-group"] },
                ],
              })
              .pipe(
                Effect.map(
                  (r) =>
                    Object.fromEntries(
                      r.Tags?.map((t) => [t.Key!, t.Value!]) ?? [],
                    ) as Record<string, string>,
                ),
              )) ?? {};

          const { removed, upsert } = diffTags(oldTags, newTags);

          if (removed.length > 0) {
            yield* ec2.deleteTags({
              Resources: [groupId],
              Tags: removed.map((key) => ({ Key: key })),
              DryRun: false,
            });
          }
          if (upsert.length > 0) {
            yield* ec2.createTags({
              Resources: [groupId],
              Tags: upsert,
              DryRun: false,
            });
            yield* session.note("Updated tags");
          }

          // Handle rule updates - simple approach: revoke all, then add all
          // Get current rules
          const currentRulesResult = yield* describeSecurityGroupRules(groupId);
          const currentRules = currentRulesResult.SecurityGroupRules ?? [];

          // Revoke existing ingress rules (except default)
          const currentIngress = currentRules.filter((r) => !r.IsEgress);
          if (currentIngress.length > 0) {
            yield* ec2
              .revokeSecurityGroupIngress({
                GroupId: groupId,
                SecurityGroupRuleIds: currentIngress.map(
                  (r) => r.SecurityGroupRuleId!,
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

          // Revoke existing egress rules
          const currentEgress = currentRules.filter((r) => r.IsEgress);
          if (currentEgress.length > 0) {
            yield* ec2
              .revokeSecurityGroupEgress({
                GroupId: groupId,
                SecurityGroupRuleIds: currentEgress.map(
                  (r) => r.SecurityGroupRuleId!,
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

          // Add new ingress rules
          if (news.ingress && news.ingress.length > 0) {
            yield* ec2.authorizeSecurityGroupIngress({
              GroupId: groupId,
              IpPermissions: news.ingress.map(toIpPermission),
              DryRun: false,
            });
            yield* session.note(
              `Updated ingress rules (${news.ingress.length} rules)`,
            );
          }

          // Add new egress rules (or restore default)
          if (news.egress && news.egress.length > 0) {
            yield* ec2.authorizeSecurityGroupEgress({
              GroupId: groupId,
              IpPermissions: news.egress.map(toIpPermission),
              DryRun: false,
            });
            yield* session.note(
              `Updated egress rules (${news.egress.length} rules)`,
            );
          } else {
            // Restore default egress rule
            yield* ec2.authorizeSecurityGroupEgress({
              GroupId: groupId,
              IpPermissions: [
                {
                  IpProtocol: "-1",
                  IpRanges: [{ CidrIp: "0.0.0.0/0" }],
                },
              ],
              DryRun: false,
            });
          }

          // Fetch the final state
          const sg = yield* describeSecurityGroup(groupId);
          const rulesResult = yield* describeSecurityGroupRules(groupId);
          return toAttrs(sg, rulesResult.SecurityGroupRules ?? []);
        }),

        delete: Effect.fn(function* ({ output, session }) {
          const groupId = output.groupId;

          yield* session.note(`Deleting Security Group: ${groupId}`);

          yield* ec2
            .deleteSecurityGroup({
              GroupId: groupId,
              DryRun: false,
            })
            .pipe(
              Effect.catchTag("InvalidGroup.NotFound", () => Effect.void),
              // Retry on dependency violations (e.g., ENIs still using the security group)
              Effect.retry({
                while: (e) => {
                  return (
                    e._tag === "DependencyViolation" ||
                    (e._tag === "ValidationError" &&
                      e.message?.includes("DependencyViolation"))
                  );
                },
                schedule: Schedule.exponential(1000, 1.5).pipe(
                  Schedule.intersect(Schedule.recurs(15)),
                  Schedule.tapOutput(([, attempt]) =>
                    session.note(
                      `Waiting for dependencies to clear... (attempt ${attempt + 1})`,
                    ),
                  ),
                ),
              }),
            );

          yield* session.note(`Security Group ${groupId} deleted`);
        }),
      };
    }),
  );
