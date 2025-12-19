import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

import type { ProviderService } from "../../provider.ts";
import { createTagger, createTagsList, diffTags } from "../../tags.ts";
import { Account } from "../account.ts";
import { Region } from "../region.ts";
import { EC2Client } from "./client.ts";
import { Eip, type AllocationId, type EipAttrs, type EipProps } from "./eip.ts";

export const eipProvider = () =>
  Eip.provider.effect(
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

      return {
        stables: ["allocationId", "eipArn", "publicIp"],

        read: Effect.fn(function* ({ output }) {
          if (!output) return undefined;
          const result = yield* ec2.describeAddresses({
            AllocationIds: [output.allocationId],
          });

          const address = result.Addresses?.[0];
          if (!address) {
            return yield* Effect.fail(
              new Error(`EIP ${output.allocationId} not found`),
            );
          }

          return {
            allocationId: address.AllocationId as AllocationId,
            eipArn:
              `arn:aws:ec2:${region}:${accountId}:elastic-ip/${address.AllocationId}` as EipAttrs<EipProps>["eipArn"],
            publicIp: address.PublicIp!,
            publicIpv4Pool: address.PublicIpv4Pool,
            domain: (address.Domain as "vpc" | "standard") ?? "vpc",
            networkBorderGroup: address.NetworkBorderGroup,
            customerOwnedIp: address.CustomerOwnedIp,
            customerOwnedIpv4Pool: address.CustomerOwnedIpv4Pool,
            carrierIp: address.CarrierIp,
          } satisfies EipAttrs<EipProps>;
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          // EIPs are immutable - any change to core properties requires replacement
          if (
            news.publicIpv4Pool !== olds.publicIpv4Pool ||
            news.networkBorderGroup !== olds.networkBorderGroup ||
            news.customerOwnedIpv4Pool !== olds.customerOwnedIpv4Pool
          ) {
            return { action: "replace" };
          }
          // Tags can be updated in-place
        }),

        create: Effect.fn(function* ({ id, news, session }) {
          yield* session.note("Allocating Elastic IP address...");

          const result = yield* ec2.allocateAddress({
            Domain: news.domain ?? "vpc",
            PublicIpv4Pool: news.publicIpv4Pool,
            NetworkBorderGroup: news.networkBorderGroup,
            CustomerOwnedIpv4Pool: news.customerOwnedIpv4Pool,
            TagSpecifications: [
              {
                ResourceType: "elastic-ip",
                Tags: createTagsList(createTags(id, news.tags)),
              },
            ],
            DryRun: false,
          });

          const allocationId = result.AllocationId! as AllocationId;
          yield* session.note(`Elastic IP allocated: ${allocationId}`);

          return {
            allocationId,
            eipArn:
              `arn:aws:ec2:${region}:${accountId}:elastic-ip/${allocationId}` as EipAttrs<EipProps>["eipArn"],
            publicIp: result.PublicIp!,
            publicIpv4Pool: result.PublicIpv4Pool,
            domain: (result.Domain as "vpc" | "standard") ?? "vpc",
            networkBorderGroup: result.NetworkBorderGroup,
            customerOwnedIp: result.CustomerOwnedIp,
            customerOwnedIpv4Pool: result.CustomerOwnedIpv4Pool,
            carrierIp: result.CarrierIp,
          } satisfies EipAttrs<EipProps>;
        }),

        update: Effect.fn(function* ({ id, news, output, session }) {
          const allocationId = output.allocationId;

          // Handle tag updates
          const newTags = createTags(id, news.tags);
          const oldTags =
            (yield* ec2
              .describeTags({
                Filters: [
                  { Name: "resource-id", Values: [allocationId] },
                  { Name: "resource-type", Values: ["elastic-ip"] },
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
              Resources: [allocationId],
              Tags: removed.map((key) => ({ Key: key })),
              DryRun: false,
            });
          }
          if (upsert.length > 0) {
            yield* ec2.createTags({
              Resources: [allocationId],
              Tags: upsert,
              DryRun: false,
            });
            yield* session.note("Updated tags");
          }

          return output;
        }),

        delete: Effect.fn(function* ({ output, session }) {
          const allocationId = output.allocationId;

          yield* session.note(`Releasing Elastic IP: ${allocationId}`);

          yield* ec2
            .releaseAddress({
              AllocationId: allocationId,
              DryRun: false,
            })
            .pipe(
              Effect.catchTag(
                "InvalidAllocationID.NotFound",
                () => Effect.void,
              ),
              Effect.catchTag("AuthFailure", () => Effect.void),
              Effect.tapError((e) => {
                return Effect.logDebug(e);
              }),
              // Retry when EIP is still in use (e.g., NAT Gateway being deleted)
              Effect.retry({
                while: (e) => {
                  return (
                    e._tag === "DependencyViolation" ||
                    // this throws if the address hasn't been disassociated from all resources
                    // we will retry it assuming that another resource provider is dissassociating it (e.g. a NAT Gateway resource is being deleted)
                    e._tag === "InvalidIPAddress.InUse"
                  );
                },
                schedule: Schedule.exponential(1000, 1.5).pipe(
                  Schedule.intersect(Schedule.recurs(20)),
                  Schedule.tapOutput(([, attempt]) =>
                    session.note(
                      `EIP still in use, waiting for release... (attempt ${attempt + 1})`,
                    ),
                  ),
                ),
              }),
            );

          yield* session.note(`Elastic IP ${allocationId} released`);
        }),
      };
    }),
  );
