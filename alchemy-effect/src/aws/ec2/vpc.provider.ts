import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

import { App, type ProviderService } from "alchemy-effect";
import type { ScopedPlanStatusSession } from "../../apply.ts";
import { createTagger, createTagsList } from "../../tags.ts";
import { Account } from "../account.ts";
import { Region } from "../region.ts";
import { EC2Client } from "./client.ts";
import { Vpc, type VpcAttrs, type VpcProps } from "./vpc.ts";

import type { EC2 } from "itty-aws/ec2";

export const vpcProvider = () =>
  Vpc.provider.effect(
    Effect.gen(function* () {
      const ec2 = yield* EC2Client;
      const app = yield* App;
      const region = yield* Region;
      const accountId = yield* Account;
      const tagged = yield* createTagger();

      return {
        diff: Effect.fn(function* ({ id, news, olds }) {
          // 1. CIDR block changes
          if (olds.cidrBlock !== news.cidrBlock) {
            return { action: "replace" } as const;
          }

          // 2. Instance tenancy changes
          if (olds.instanceTenancy !== news.instanceTenancy) {
            return { action: "replace" } as const;
          }

          // 3. IPAM pool changes
          if (olds.ipv4IpamPoolId !== news.ipv4IpamPoolId) {
            return { action: "replace" } as const;
          }

          if (olds.ipv6IpamPoolId !== news.ipv6IpamPoolId) {
            return { action: "replace" } as const;
          }

          // 4. IPv6 CIDR block changes
          if (olds.ipv6CidrBlock !== news.ipv6CidrBlock) {
            return { action: "replace" } as const;
          }

          // 5. IPv6 pool changes
          if (olds.ipv6Pool !== news.ipv6Pool) {
            return { action: "replace" } as const;
          }
        }),

        create: Effect.fn(function* ({ id, news, session }) {
          // 1. Prepare tags
          const alchemyTags = tagged(id);
          const userTags = news.tags ?? {};
          const allTags = { ...alchemyTags, ...userTags };

          // 2. Call CreateVpc
          const createResult = yield* ec2.createVpc({
            // TODO(sam): add all properties
            AmazonProvidedIpv6CidrBlock: news.amazonProvidedIpv6CidrBlock,
            InstanceTenancy: news.instanceTenancy,
            CidrBlock: news.cidrBlock,
            Ipv4IpamPoolId: news.ipv4IpamPoolId,
            Ipv4NetmaskLength: news.ipv4NetmaskLength,
            Ipv6Pool: news.ipv6Pool,
            Ipv6CidrBlock: news.ipv6CidrBlock,
            Ipv6IpamPoolId: news.ipv6IpamPoolId,
            Ipv6NetmaskLength: news.ipv6NetmaskLength,
            Ipv6CidrBlockNetworkBorderGroup:
              news.ipv6CidrBlockNetworkBorderGroup,
            TagSpecifications: [
              {
                ResourceType: "vpc",
                Tags: createTagsList(allTags),
              },
            ],
            DryRun: false,
          });

          const vpcId = createResult.Vpc!.VpcId!;
          yield* session.note(`VPC created: ${vpcId}`);

          // 3. Modify DNS attributes if specified (separate API calls)
          yield* ec2.modifyVpcAttribute({
            VpcId: vpcId,
            EnableDnsSupport: { Value: news.enableDnsSupport ?? true },
          });

          if (news.enableDnsHostnames !== undefined) {
            yield* ec2.modifyVpcAttribute({
              VpcId: vpcId,
              EnableDnsHostnames: { Value: news.enableDnsHostnames },
            });
          }

          // 4. Wait for VPC to be available
          const vpc = yield* waitForVpcAvailable(ec2, vpcId, session);

          // 6. Return attributes
          return {
            vpcId,
            vpcArn:
              `arn:aws:ec2:${region}:${accountId}:vpc/${vpcId}` as VpcAttrs<VpcProps>["vpcArn"],
            cidrBlock: vpc.CidrBlock!,
            dhcpOptionsId: vpc.DhcpOptionsId!,
            state: vpc.State!,
            isDefault: vpc.IsDefault ?? false,
            ownerId: vpc.OwnerId,
            cidrBlockAssociationSet: vpc.CidrBlockAssociationSet?.map(
              (assoc) => ({
                associationId: assoc.AssociationId!,
                cidrBlock: assoc.CidrBlock!,
                cidrBlockState: {
                  state: assoc.CidrBlockState!.State!,
                  statusMessage: assoc.CidrBlockState!.StatusMessage,
                },
              }),
            ),
            ipv6CidrBlockAssociationSet: vpc.Ipv6CidrBlockAssociationSet?.map(
              (assoc) => ({
                associationId: assoc.AssociationId!,
                ipv6CidrBlock: assoc.Ipv6CidrBlock!,
                ipv6CidrBlockState: {
                  state: assoc.Ipv6CidrBlockState!.State!,
                  statusMessage: assoc.Ipv6CidrBlockState!.StatusMessage,
                },
                networkBorderGroup: assoc.NetworkBorderGroup,
                ipv6Pool: assoc.Ipv6Pool,
              }),
            ),
          } satisfies VpcAttrs<VpcProps>;
        }),

        update: Effect.fn(function* ({ news, olds, output, session }) {
          const vpcId = output.vpcId;

          // Only DNS and metrics settings can be updated
          // Everything else requires replacement (handled by diff)

          if (news.enableDnsSupport !== olds.enableDnsSupport) {
            yield* ec2.modifyVpcAttribute({
              VpcId: vpcId,
              EnableDnsSupport: { Value: news.enableDnsSupport ?? true },
            });
            yield* session.note("Updated DNS support");
          }

          if (news.enableDnsHostnames !== olds.enableDnsHostnames) {
            yield* ec2.modifyVpcAttribute({
              VpcId: vpcId,
              EnableDnsHostnames: { Value: news.enableDnsHostnames ?? false },
            });
            yield* session.note("Updated DNS hostnames");
          }

          // Note: Tag updates would go here if we support user tag changes

          return output; // VPC attributes don't change from these updates
        }),

        delete: Effect.fn(function* ({ output, session }) {
          const vpcId = output.vpcId;

          yield* session.note(`Deleting VPC: ${vpcId}`);

          // 1. Attempt to delete VPC
          yield* ec2
            .deleteVpc({
              VpcId: vpcId,
              DryRun: false,
            })
            .pipe(
              Effect.tapError(Effect.logDebug),
              Effect.catchTag("InvalidVpcID.NotFound", () => Effect.void),
              // Retry on dependency violations (resources still being deleted)
              Effect.retry({
                while: (e) => {
                  // DependencyViolation means there are still dependent resources
                  // This can happen if subnets/IGW are being deleted concurrently
                  return (
                    e._tag === "ValidationError" &&
                    e.message?.includes("DependencyViolation")
                  );
                },
                schedule: Schedule.exponential(1000, 1.5).pipe(
                  Schedule.intersect(Schedule.recurs(10)), // Try up to 10 times
                  Schedule.tapOutput(([, attempt]) =>
                    session.note(
                      `Waiting for dependencies to clear... (attempt ${attempt + 1})`,
                    ),
                  ),
                ),
              }),
            );

          // 2. Wait for VPC to be fully deleted
          yield* waitForVpcDeleted(ec2, vpcId, session);

          yield* session.note(`VPC ${vpcId} deleted successfully`);
        }),
      } satisfies ProviderService<Vpc>;
    }),
  );

/**
 * Wait for VPC to be in available state
 */
const waitForVpcAvailable = (
  ec2: EC2,
  vpcId: string,
  session?: ScopedPlanStatusSession,
) =>
  Effect.retry(
    Effect.gen(function* () {
      const result = yield* ec2
        .describeVpcs({ VpcIds: [vpcId] })
        .pipe(
          Effect.catchTag("InvalidVpcID.NotFound", () =>
            Effect.succeed({ Vpcs: [] }),
          ),
        );
      const vpc = result.Vpcs![0];

      if (vpc.State === "available") {
        return vpc;
      }

      // Still pending, fail to trigger retry
      return yield* Effect.fail(new Error("VPC not yet available"));
    }),
    {
      schedule: Schedule.fixed(2000).pipe(
        // Check every 2 seconds
        Schedule.intersect(Schedule.recurs(30)), // Max 60 seconds
        Schedule.tapOutput(([, attempt]) =>
          session
            ? session.note(
                `Waiting for VPC to be available... (${(attempt + 1) * 2}s)`,
              )
            : Effect.void,
        ),
      ),
    },
  );

/**
 * Wait for VPC to be deleted
 */
const waitForVpcDeleted = (
  ec2: EC2,
  vpcId: string,
  session: ScopedPlanStatusSession,
) =>
  Effect.gen(function* () {
    yield* Effect.retry(
      Effect.gen(function* () {
        const result = yield* ec2.describeVpcs({ VpcIds: [vpcId] }).pipe(
          Effect.tapError(Effect.logDebug),
          Effect.catchTag("InvalidVpcID.NotFound", () =>
            Effect.succeed({ Vpcs: [] }),
          ),
        );

        if (!result.Vpcs || result.Vpcs.length === 0) {
          return; // Successfully deleted
        }

        // Still exists, fail to trigger retry
        return yield* Effect.fail(new Error("VPC still exists"));
      }),
      {
        schedule: Schedule.fixed(2000).pipe(
          // Check every 2 seconds
          Schedule.intersect(Schedule.recurs(15)), // Max 30 seconds
          Schedule.tapOutput(([, attempt]) =>
            session.note(`Waiting for VPC deletion... (${(attempt + 1) * 2}s)`),
          ),
        ),
      },
    );
  });
