import * as Effect from "effect/Effect";

import { createTagger, createTagsList, diffTags } from "../../tags.ts";
import { Account } from "../account.ts";
import { Region } from "../region.ts";
import { EC2Client } from "./client.ts";
import {
  type EgressOnlyInternetGatewayArn,
  EgressOnlyInternetGateway,
  type EgressOnlyInternetGatewayAttrs,
  type EgressOnlyInternetGatewayId,
} from "./egress-only-igw.ts";
import type * as EC2 from "itty-aws/ec2";
import type { VpcId } from "./vpc.ts";

export const egressOnlyInternetGatewayProvider = () =>
  EgressOnlyInternetGateway.provider.effect(
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

      const describeEgressOnlyInternetGateway = (eigwId: string) =>
        ec2
          .describeEgressOnlyInternetGateways({
            EgressOnlyInternetGatewayIds: [eigwId],
          })
          .pipe(
            Effect.map((r) => r.EgressOnlyInternetGateways?.[0]),
            Effect.flatMap((gw) =>
              gw
                ? Effect.succeed(gw)
                : Effect.fail(
                    new Error(
                      `Egress-Only Internet Gateway ${eigwId} not found`,
                    ),
                  ),
            ),
          );

      const toAttrs = (
        gw: EC2.EgressOnlyInternetGateway,
      ): EgressOnlyInternetGatewayAttrs => ({
        egressOnlyInternetGatewayId:
          gw.EgressOnlyInternetGatewayId as EgressOnlyInternetGatewayId,
        egressOnlyInternetGatewayArn:
          `arn:aws:ec2:${region}:${accountId}:egress-only-internet-gateway/${gw.EgressOnlyInternetGatewayId}` as EgressOnlyInternetGatewayArn,
        attachments: gw.Attachments?.map((a) => ({
          state: a.State as "attaching" | "attached" | "detaching" | "detached",
          vpcId: a.VpcId as VpcId,
        })),
      });

      return {
        stables: [
          "egressOnlyInternetGatewayId",
          "egressOnlyInternetGatewayArn",
        ],

        read: Effect.fn(function* ({ output }) {
          if (!output) return undefined;
          const gw = yield* describeEgressOnlyInternetGateway(
            output.egressOnlyInternetGatewayId,
          );
          return toAttrs(gw);
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          // VPC change requires replacement
          if (news.vpcId !== olds.vpcId) {
            return { action: "replace" };
          }
          // Tags can be updated in-place
        }),

        create: Effect.fn(function* ({ id, news, session }) {
          yield* session.note("Creating Egress-Only Internet Gateway...");

          const result = yield* ec2.createEgressOnlyInternetGateway({
            VpcId: news.vpcId as string,
            TagSpecifications: [
              {
                ResourceType: "egress-only-internet-gateway",
                Tags: createTagsList(createTags(id, news.tags)),
              },
            ],
            DryRun: false,
          });

          const eigwId =
            result.EgressOnlyInternetGateway!.EgressOnlyInternetGatewayId!;
          yield* session.note(
            `Egress-Only Internet Gateway created: ${eigwId}`,
          );

          const gw = yield* describeEgressOnlyInternetGateway(eigwId);
          return toAttrs(gw);
        }),

        update: Effect.fn(function* ({ id, news, output, session }) {
          const eigwId = output.egressOnlyInternetGatewayId;

          // Handle tag updates
          const newTags = createTags(id, news.tags);
          const oldTags =
            (yield* ec2
              .describeTags({
                Filters: [
                  { Name: "resource-id", Values: [eigwId] },
                  {
                    Name: "resource-type",
                    Values: ["egress-only-internet-gateway"],
                  },
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
              Resources: [eigwId],
              Tags: removed.map((key) => ({ Key: key })),
              DryRun: false,
            });
          }
          if (upsert.length > 0) {
            yield* ec2.createTags({
              Resources: [eigwId],
              Tags: upsert,
              DryRun: false,
            });
            yield* session.note("Updated tags");
          }

          const gw = yield* describeEgressOnlyInternetGateway(eigwId);
          return toAttrs(gw);
        }),

        delete: Effect.fn(function* ({ output, session }) {
          const eigwId = output.egressOnlyInternetGatewayId;

          yield* session.note(
            `Deleting Egress-Only Internet Gateway: ${eigwId}`,
          );

          yield* ec2
            .deleteEgressOnlyInternetGateway({
              EgressOnlyInternetGatewayId: eigwId,
              DryRun: false,
            })
            .pipe(
              Effect.catchTag("InvalidGatewayID.NotFound", () => Effect.void),
              Effect.catchTag(
                "InvalidEgressOnlyInternetGatewayId.NotFound",
                () => Effect.void,
              ),
            );

          yield* session.note(`Egress-Only Internet Gateway ${eigwId} deleted`);
        }),
      };
    }),
  );
