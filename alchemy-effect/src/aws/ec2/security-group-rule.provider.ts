import * as Effect from "effect/Effect";

import { createTagger, createTagsList, diffTags } from "../../tags.ts";
import { EC2Client } from "./client.ts";
import {
  SecurityGroupRule,
  type SecurityGroupRuleAttrs,
  type SecurityGroupRuleId,
} from "./security-group-rule.ts";
import type { SecurityGroupId } from "./security-group.ts";

export const securityGroupRuleProvider = () =>
  SecurityGroupRule.provider.effect(
    Effect.gen(function* () {
      const ec2 = yield* EC2Client;
      const tagged = yield* createTagger();

      const createTags = (
        id: string,
        tags?: Record<string, string>,
      ): Record<string, string> => ({
        Name: id,
        ...tagged(id),
        ...tags,
      });

      const describeRule = (ruleId: string) =>
        ec2.describeSecurityGroupRules({ SecurityGroupRuleIds: [ruleId] }).pipe(
          Effect.map((r) => r.SecurityGroupRules?.[0]),
          Effect.flatMap((rule) =>
            rule
              ? Effect.succeed(rule)
              : Effect.fail(
                  new Error(`Security Group Rule ${ruleId} not found`),
                ),
          ),
        );

      const toAttrs = (
        rule: Awaited<
          ReturnType<
            typeof describeRule extends (
              ...args: any
            ) => Effect.Effect<infer R, any, any>
              ? () => Promise<R>
              : never
          >
        >,
      ): SecurityGroupRuleAttrs => ({
        securityGroupRuleId: rule.SecurityGroupRuleId as SecurityGroupRuleId,
        groupId: rule.GroupId as SecurityGroupId,
        groupOwnerId: rule.GroupOwnerId!,
        isEgress: rule.IsEgress as any,
        ipProtocol: rule.IpProtocol!,
        fromPort: rule.FromPort,
        toPort: rule.ToPort,
        cidrIpv4: rule.CidrIpv4,
        cidrIpv6: rule.CidrIpv6,
        referencedGroupId: rule.ReferencedGroupInfo?.GroupId,
        prefixListId: rule.PrefixListId,
        description: rule.Description,
      });

      return {
        stables: ["securityGroupRuleId", "groupOwnerId"],

        read: Effect.fn(function* ({ output }) {
          if (!output) return undefined;
          const rule = yield* describeRule(output.securityGroupRuleId);
          return toAttrs(rule);
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          // Most properties require replacement
          if (
            news.groupId !== olds.groupId ||
            news.type !== olds.type ||
            news.ipProtocol !== olds.ipProtocol ||
            news.fromPort !== olds.fromPort ||
            news.toPort !== olds.toPort ||
            news.cidrIpv4 !== olds.cidrIpv4 ||
            news.cidrIpv6 !== olds.cidrIpv6 ||
            news.referencedGroupId !== olds.referencedGroupId ||
            news.prefixListId !== olds.prefixListId
          ) {
            return { action: "replace" };
          }
          // Description and tags can be updated
        }),

        create: Effect.fn(function* ({ id, news, session }) {
          yield* session.note(`Creating Security Group Rule...`);

          const ipPermission = {
            IpProtocol: news.ipProtocol,
            FromPort: news.fromPort,
            ToPort: news.toPort,
            IpRanges: news.cidrIpv4
              ? [{ CidrIp: news.cidrIpv4, Description: news.description }]
              : undefined,
            Ipv6Ranges: news.cidrIpv6
              ? [{ CidrIpv6: news.cidrIpv6, Description: news.description }]
              : undefined,
            UserIdGroupPairs: news.referencedGroupId
              ? [
                  {
                    GroupId: news.referencedGroupId as string,
                    Description: news.description,
                  },
                ]
              : undefined,
            PrefixListIds: news.prefixListId
              ? [
                  {
                    PrefixListId: news.prefixListId as string,
                    Description: news.description,
                  },
                ]
              : undefined,
          };

          let ruleId: string;

          if (news.type === "ingress") {
            const result = yield* ec2.authorizeSecurityGroupIngress({
              GroupId: news.groupId as string,
              IpPermissions: [ipPermission],
              TagSpecifications: [
                {
                  ResourceType: "security-group-rule",
                  Tags: createTagsList(createTags(id, news.tags)),
                },
              ],
              DryRun: false,
            });
            ruleId = result.SecurityGroupRules?.[0]?.SecurityGroupRuleId!;
          } else {
            const result = yield* ec2.authorizeSecurityGroupEgress({
              GroupId: news.groupId as string,
              IpPermissions: [ipPermission],
              TagSpecifications: [
                {
                  ResourceType: "security-group-rule",
                  Tags: createTagsList(createTags(id, news.tags)),
                },
              ],
              DryRun: false,
            });
            ruleId = result.SecurityGroupRules?.[0]?.SecurityGroupRuleId!;
          }

          yield* session.note(`Security Group Rule created: ${ruleId}`);

          const rule = yield* describeRule(ruleId);
          return toAttrs(rule);
        }),

        update: Effect.fn(function* ({ id, news, olds, output, session }) {
          const ruleId = output.securityGroupRuleId;

          // Update description if changed
          if (news.description !== olds.description) {
            yield* ec2.modifySecurityGroupRules({
              GroupId: news.groupId as string,
              SecurityGroupRules: [
                {
                  SecurityGroupRuleId: ruleId,
                  SecurityGroupRule: {
                    IpProtocol: news.ipProtocol,
                    FromPort: news.fromPort,
                    ToPort: news.toPort,
                    CidrIpv4: news.cidrIpv4,
                    CidrIpv6: news.cidrIpv6,
                    ReferencedGroupId: news.referencedGroupId as
                      | string
                      | undefined,
                    PrefixListId: news.prefixListId as string | undefined,
                    Description: news.description,
                  },
                },
              ],
            });
            yield* session.note("Updated description");
          }

          // Handle tag updates
          const newTags = createTags(id, news.tags);
          const oldTags =
            (yield* ec2
              .describeTags({
                Filters: [
                  { Name: "resource-id", Values: [ruleId] },
                  { Name: "resource-type", Values: ["security-group-rule"] },
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
              Resources: [ruleId],
              Tags: removed.map((key) => ({ Key: key })),
              DryRun: false,
            });
          }
          if (upsert.length > 0) {
            yield* ec2.createTags({
              Resources: [ruleId],
              Tags: upsert,
              DryRun: false,
            });
            yield* session.note("Updated tags");
          }

          const rule = yield* describeRule(ruleId);
          return toAttrs(rule);
        }),

        delete: Effect.fn(function* ({ olds, output, session }) {
          const ruleId = output.securityGroupRuleId;

          yield* session.note(`Deleting Security Group Rule: ${ruleId}`);

          if (olds.type === "ingress") {
            yield* ec2
              .revokeSecurityGroupIngress({
                GroupId: olds.groupId as string,
                SecurityGroupRuleIds: [ruleId],
                DryRun: false,
              })
              .pipe(
                Effect.catchTag(
                  "InvalidPermission.NotFound",
                  () => Effect.void,
                ),
              );
          } else {
            yield* ec2
              .revokeSecurityGroupEgress({
                GroupId: olds.groupId as string,
                SecurityGroupRuleIds: [ruleId],
                DryRun: false,
              })
              .pipe(
                Effect.catchTag(
                  "InvalidPermission.NotFound",
                  () => Effect.void,
                ),
              );
          }

          yield* session.note(`Security Group Rule ${ruleId} deleted`);
        }),
      };
    }),
  );
