import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type * as EC2 from "itty-aws/ec2";

import type { ScopedPlanStatusSession } from "../../cli/service.ts";
import {
  createAlchemyTagFilters,
  createTagger,
  createTagsList,
  diffTags,
} from "../../tags.ts";
import { Account } from "../account.ts";
import { Region } from "../region.ts";
import { EC2Client } from "./client.ts";
import {
  NatGateway,
  type NatGatewayAttrs,
  type NatGatewayId,
  type NatGatewayProps,
} from "./nat-gateway.ts";

export const natGatewayProvider = () =>
  NatGateway.provider.effect(
    // @ts-expect-error
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

      const describeNatGateway = (natGatewayId: string) =>
        ec2.describeNatGateways({ NatGatewayIds: [natGatewayId] }).pipe(
          Effect.map((r) => r.NatGateways?.[0]),
          Effect.flatMap((gw) =>
            gw
              ? Effect.succeed(gw)
              : Effect.fail(new Error(`NAT Gateway ${natGatewayId} not found`)),
          ),
        );

      const toAttrs = (
        gw: EC2.NatGateway,
      ): NatGatewayAttrs<NatGatewayProps> => {
        const primaryAddress =
          gw.NatGatewayAddresses?.find((a) => a.IsPrimary) ??
          gw.NatGatewayAddresses?.[0];
        return {
          natGatewayId: gw.NatGatewayId as NatGatewayId,
          natGatewayArn:
            `arn:aws:ec2:${region}:${accountId}:natgateway/${gw.NatGatewayId}` as NatGatewayAttrs<NatGatewayProps>["natGatewayArn"],
          subnetId: gw.SubnetId as NatGatewayAttrs<NatGatewayProps>["subnetId"],
          vpcId: gw.VpcId!,
          state: gw.State!,
          connectivityType: gw.ConnectivityType!,
          publicIp: primaryAddress?.PublicIp,
          privateIp: primaryAddress?.PrivateIp,
          natGatewayAddresses: gw.NatGatewayAddresses?.map((a) => ({
            allocationId: a.AllocationId,
            networkInterfaceId: a.NetworkInterfaceId,
            privateIp: a.PrivateIp,
            publicIp: a.PublicIp,
            associationId: a.AssociationId,
            isPrimary: a.IsPrimary,
            failureMessage: a.FailureMessage,
            status: a.Status,
          })),
          failureCode: gw.FailureCode,
          failureMessage: gw.FailureMessage,
          createTime:
            gw.CreateTime instanceof Date
              ? gw.CreateTime.toISOString()
              : (gw.CreateTime as string | undefined),
          deleteTime:
            gw.DeleteTime instanceof Date
              ? gw.DeleteTime.toISOString()
              : (gw.DeleteTime as string | undefined),
        };
      };

      // Find NAT Gateway by alchemy tags when we don't have the ID
      const findNatGatewayByTags = Effect.fn(function* (id: string) {
        const filters = yield* createAlchemyTagFilters(id);
        const result = yield* ec2.describeNatGateways({ Filter: filters });

        // Find a NAT Gateway that's not deleted and has matching tags
        for (const gw of result.NatGateways ?? []) {
          return gw;
        }
        return undefined;
      });

      return {
        stables: ["natGatewayId", "natGatewayArn", "vpcId"],

        read: Effect.fn(function* ({ id, output }) {
          if (output) {
            // We have the NAT Gateway ID, use it directly
            return toAttrs(yield* describeNatGateway(output.natGatewayId));
          }

          // No output - try to find by tags (recovery from incomplete create)
          const gw = yield* findNatGatewayByTags(id);
          if (gw) {
            return toAttrs(gw);
          }

          // Not found
          return undefined;
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          // NAT Gateway is mostly immutable - any change to core properties requires replacement
          if (
            news.subnetId !== olds.subnetId ||
            news.connectivityType !== olds.connectivityType ||
            news.allocationId !== olds.allocationId
          ) {
            return { action: "replace" };
          }
          // Tags can be updated in-place
        }),

        create: Effect.fn(function* ({ id, news, session }) {
          yield* session.note("Creating NAT Gateway...");

          const result = yield* ec2.createNatGateway({
            SubnetId: news.subnetId as string,
            AllocationId: news.allocationId as string | undefined,
            ConnectivityType: news.connectivityType ?? "public",
            PrivateIpAddress: news.privateIpAddress,
            SecondaryAllocationIds: news.secondaryAllocationIds as
              | string[]
              | undefined,
            SecondaryPrivateIpAddresses: news.secondaryPrivateIpAddresses,
            SecondaryPrivateIpAddressCount: news.secondaryPrivateIpAddressCount,
            TagSpecifications: [
              {
                ResourceType: "natgateway",
                Tags: createTagsList(createTags(id, news.tags)),
              },
            ],
            DryRun: false,
          });

          const natGatewayId = result.NatGateway!.NatGatewayId!;
          yield* session.note(`NAT Gateway created: ${natGatewayId}`);

          // Wait for NAT Gateway to be available
          const gw = yield* waitForNatGatewayAvailable(natGatewayId, session);

          return toAttrs(gw);
        }),

        update: Effect.fn(function* ({ id, news, output, session }) {
          const natGatewayId = output.natGatewayId;

          // Handle tag updates
          const newTags = createTags(id, news.tags);
          const oldTags =
            (yield* ec2
              .describeTags({
                Filters: [
                  { Name: "resource-id", Values: [natGatewayId] },
                  { Name: "resource-type", Values: ["natgateway"] },
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
              Resources: [natGatewayId],
              Tags: removed.map((key) => ({ Key: key })),
              DryRun: false,
            });
          }
          if (upsert.length > 0) {
            yield* ec2.createTags({
              Resources: [natGatewayId],
              Tags: upsert,
              DryRun: false,
            });
            yield* session.note("Updated tags");
          }

          // Refresh state
          const gw = yield* describeNatGateway(natGatewayId);
          return toAttrs(gw);
        }),

        delete: Effect.fn(function* ({ output, session }) {
          const natGatewayId = output.natGatewayId;

          yield* session.note(`Deleting NAT Gateway: ${natGatewayId}`);

          yield* ec2
            .deleteNatGateway({
              NatGatewayId: natGatewayId,
              DryRun: false,
            })
            .pipe(Effect.catchTag("NatGatewayNotFound", () => Effect.void));

          // Wait for NAT Gateway to be deleted
          yield* waitForNatGatewayDeleted(natGatewayId, session);

          yield* session.note(`NAT Gateway ${natGatewayId} deleted`);
        }),
      };
    }),
  );

// Retryable error: NAT Gateway is still pending
class NatGatewayPending extends Data.TaggedError("NatGatewayPending")<{
  natGatewayId: string;
  state: string;
}> {}

// Terminal error: NAT Gateway creation failed
class NatGatewayFailed extends Data.TaggedError("NatGatewayFailed")<{
  natGatewayId: string;
  failureCode?: string;
  failureMessage?: string;
}> {}

// Terminal error: NAT Gateway not found
class NatGatewayNotFound extends Data.TaggedError("NatGatewayNotFound")<{
  natGatewayId: string;
}> {}

/**
 * Wait for NAT Gateway to be in available state
 */
const waitForNatGatewayAvailable = (
  natGatewayId: string,
  session: ScopedPlanStatusSession,
) =>
  Effect.gen(function* () {
    const ec2 = yield* EC2Client;
    const result = yield* ec2.describeNatGateways({
      NatGatewayIds: [natGatewayId],
    });
    const gw = result.NatGateways?.[0];

    if (!gw) {
      return yield* new NatGatewayNotFound({ natGatewayId });
    }

    if (gw.State === "available") {
      return gw;
    }

    if (gw.State === "failed") {
      return yield* new NatGatewayFailed({
        natGatewayId,
        failureCode: gw.FailureCode,
        failureMessage: gw.FailureMessage,
      });
    }

    // Still pending - this is the only retryable case
    return yield* new NatGatewayPending({ natGatewayId, state: gw.State! });
  }).pipe(
    Effect.tapError(Effect.logDebug),
    Effect.retry({
      while: (e) => e._tag === "NatGatewayPending",
      schedule: Schedule.fixed(5000).pipe(
        Schedule.intersect(Schedule.recurs(60)), // Max 5 minutes
        Schedule.tapOutput(([, attempt]) =>
          session.note(
            `Waiting for NAT Gateway to be available... (${(attempt + 1) * 5}s)`,
          ),
        ),
      ),
    }),
  );

// Retryable error: NAT Gateway is still deleting
class NatGatewayDeleting extends Data.TaggedError("NatGatewayDeleting")<{
  natGatewayId: string;
  state: string;
}> {}

/**
 * Wait for NAT Gateway to be deleted
 */
const waitForNatGatewayDeleted = (
  natGatewayId: string,
  session: ScopedPlanStatusSession,
) =>
  Effect.gen(function* () {
    const ec2 = yield* EC2Client;
    const result = yield* ec2
      .describeNatGateways({ NatGatewayIds: [natGatewayId] })
      .pipe(
        Effect.catchTag("NatGatewayNotFound", () =>
          Effect.succeed({ NatGateways: [] }),
        ),
      );

    const gw = result.NatGateways?.[0];

    if (!gw || gw.State === "deleted") {
      return; // Successfully deleted
    }

    yield* Effect.logDebug(gw);

    // Still deleting - this is the only retryable case
    return yield* new NatGatewayDeleting({ natGatewayId, state: gw.State! });
  }).pipe(
    Effect.tapError(Effect.logDebug),
    Effect.retry({
      while: (e) => e._tag === "NatGatewayDeleting",
      schedule: Schedule.fixed(5000).pipe(
        Schedule.intersect(Schedule.recurs(60)), // Max 5 minutes
        Schedule.tapOutput(([, attempt]) =>
          session.note(
            `Waiting for NAT Gateway deletion... (${(attempt + 1) * 5}s)`,
          ),
        ),
      ),
    }),
  );
