import * as Effect from "effect/Effect";

import { EC2Client } from "./client.ts";
import {
  NetworkAclEntry,
  type NetworkAclEntryAttrs,
  type NetworkAclEntryProps,
} from "./network-acl-entry.ts";

export const networkAclEntryProvider = () =>
  NetworkAclEntry.provider.effect(
    // @ts-expect-error - TODO: fix this
    Effect.gen(function* () {
      const ec2 = yield* EC2Client;

      const findEntry = (
        networkAclId: string,
        ruleNumber: number,
        egress: boolean,
      ) =>
        ec2
          .describeNetworkAcls({ NetworkAclIds: [networkAclId] })
          .pipe(
            Effect.map((r) =>
              r.NetworkAcls?.[0]?.Entries?.find(
                (e) => e.RuleNumber === ruleNumber && e.Egress === egress,
              ),
            ),
          );

      const toAttrs = (
        props: NetworkAclEntryProps,
        entry: NonNullable<
          Awaited<
            ReturnType<
              typeof findEntry extends (
                ...args: any
              ) => Effect.Effect<infer R, any, any>
                ? () => Promise<R>
                : never
            >
          >
        >,
      ): NetworkAclEntryAttrs<NetworkAclEntryProps> => ({
        networkAclId:
          props.networkAclId as NetworkAclEntryAttrs<NetworkAclEntryProps>["networkAclId"],
        ruleNumber:
          entry.RuleNumber as NetworkAclEntryAttrs<NetworkAclEntryProps>["ruleNumber"],
        egress: entry.Egress!,
        protocol:
          entry.Protocol as NetworkAclEntryAttrs<NetworkAclEntryProps>["protocol"],
        ruleAction:
          entry.RuleAction as NetworkAclEntryAttrs<NetworkAclEntryProps>["ruleAction"],
        cidrBlock: entry.CidrBlock,
        ipv6CidrBlock: entry.Ipv6CidrBlock,
        icmpTypeCode: entry.IcmpTypeCode
          ? {
              code: entry.IcmpTypeCode.Code,
              type: entry.IcmpTypeCode.Type,
            }
          : undefined,
        portRange: entry.PortRange
          ? {
              from: entry.PortRange.From,
              to: entry.PortRange.To,
            }
          : undefined,
      });

      return {
        stables: [],

        read: Effect.fn(function* ({ olds, output }) {
          if (!output) return undefined;
          const entry = yield* findEntry(
            olds.networkAclId as string,
            output.ruleNumber,
            output.egress,
          );
          if (!entry) {
            return yield* Effect.fail(
              new Error(
                `Network ACL Entry not found: ${output.networkAclId} rule ${output.ruleNumber} egress=${output.egress}`,
              ),
            );
          }
          return toAttrs(olds, entry);
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          // If network ACL, rule number, or egress changes, need to replace
          if (
            news.networkAclId !== olds.networkAclId ||
            news.ruleNumber !== olds.ruleNumber ||
            news.egress !== olds.egress
          ) {
            return { action: "replace" };
          }
          // Other properties can be updated by replacing the entry
        }),

        create: Effect.fn(function* ({ news, session }) {
          yield* session.note(
            `Creating Network ACL Entry (rule ${news.ruleNumber})...`,
          );

          yield* ec2.createNetworkAclEntry({
            NetworkAclId: news.networkAclId as string,
            RuleNumber: news.ruleNumber,
            Protocol: news.protocol,
            RuleAction: news.ruleAction,
            Egress: news.egress ?? false,
            CidrBlock: news.cidrBlock,
            Ipv6CidrBlock: news.ipv6CidrBlock,
            IcmpTypeCode: news.icmpTypeCode
              ? {
                  Code: news.icmpTypeCode.code,
                  Type: news.icmpTypeCode.type,
                }
              : undefined,
            PortRange: news.portRange
              ? {
                  From: news.portRange.from,
                  To: news.portRange.to,
                }
              : undefined,
            DryRun: false,
          });

          yield* session.note(
            `Network ACL Entry created: rule ${news.ruleNumber}`,
          );

          const entry = yield* findEntry(
            news.networkAclId as string,
            news.ruleNumber,
            news.egress ?? false,
          );
          if (!entry) {
            return yield* Effect.fail(
              new Error("Network ACL Entry not found after creation"),
            );
          }
          return toAttrs(news, entry);
        }),

        update: Effect.fn(function* ({ news, session }) {
          // To update a network ACL entry, we need to replace it
          yield* session.note(
            `Updating Network ACL Entry (rule ${news.ruleNumber})...`,
          );

          yield* ec2.replaceNetworkAclEntry({
            NetworkAclId: news.networkAclId as string,
            RuleNumber: news.ruleNumber,
            Protocol: news.protocol,
            RuleAction: news.ruleAction,
            Egress: news.egress ?? false,
            CidrBlock: news.cidrBlock,
            Ipv6CidrBlock: news.ipv6CidrBlock,
            IcmpTypeCode: news.icmpTypeCode
              ? {
                  Code: news.icmpTypeCode.code,
                  Type: news.icmpTypeCode.type,
                }
              : undefined,
            PortRange: news.portRange
              ? {
                  From: news.portRange.from,
                  To: news.portRange.to,
                }
              : undefined,
            DryRun: false,
          });

          yield* session.note(
            `Network ACL Entry updated: rule ${news.ruleNumber}`,
          );

          const entry = yield* findEntry(
            news.networkAclId as string,
            news.ruleNumber,
            news.egress ?? false,
          );
          if (!entry) {
            return yield* Effect.fail(
              new Error("Network ACL Entry not found after update"),
            );
          }
          return toAttrs(news, entry);
        }),

        delete: Effect.fn(function* ({ olds, output, session }) {
          yield* session.note(
            `Deleting Network ACL Entry (rule ${output.ruleNumber})...`,
          );

          yield* ec2
            .deleteNetworkAclEntry({
              NetworkAclId: olds.networkAclId as string,
              RuleNumber: output.ruleNumber,
              Egress: output.egress,
              DryRun: false,
            })
            .pipe(
              Effect.catchTag(
                "InvalidNetworkAclEntry.NotFound",
                () => Effect.void,
              ),
            );

          yield* session.note(
            `Network ACL Entry deleted: rule ${output.ruleNumber}`,
          );
        }),
      };
    }),
  );
