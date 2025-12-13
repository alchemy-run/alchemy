import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

import type { EC2 } from "itty-aws/ec2";

import type { ScopedPlanStatusSession } from "../../cli/service.ts";
import { somePropsAreDifferent } from "../../diff.ts";
import type { ProviderService } from "../../provider.ts";
import { createTagger, createTagsList } from "../../tags.ts";
import { EC2Client } from "./client.ts";
import {
  Subnet,
  type SubnetAttrs,
  type SubnetId,
  type SubnetProps,
} from "./subnet.ts";

export const subnetProvider = () =>
  Subnet.provider.effect(
    Effect.gen(function* () {
      const ec2 = yield* EC2Client;
      const tagged = yield* createTagger();

      return {
        stables: ["subnetId", "subnetArn", "ownerId", "vpcId"],
        diff: Effect.fn(function* ({ news, olds }) {
          if (
            somePropsAreDifferent(olds, news, [
              "vpcId",
              "cidrBlock",
              "availabilityZone",
              "availabilityZoneId",
              "ipv6CidrBlock",
              "ipv4IpamPoolId",
              "ipv6IpamPoolId",
            ])
          ) {
            return { action: "replace" };
          }
        }),

        create: Effect.fn(function* ({ id, news, session }) {
          // 1. Get VPC ID from the VPC resource
          // TODO(sam): i need to make it possible to pass Resources as input Props to Resources
          const vpcId = news.vpcId;

          // 2. Prepare tags
          const alchemyTags = tagged(id);
          const userTags = news.tags ?? {};
          const allTags = { ...alchemyTags, ...userTags };

          // 3. Call CreateSubnet
          const createResult = yield* ec2
            .createSubnet({
              VpcId: vpcId,
              CidrBlock: news.cidrBlock,
              Ipv6CidrBlock: news.ipv6CidrBlock,
              AvailabilityZone: news.availabilityZone,
              AvailabilityZoneId: news.availabilityZoneId,
              Ipv4IpamPoolId: news.ipv4IpamPoolId,
              Ipv4NetmaskLength: news.ipv4NetmaskLength,
              Ipv6IpamPoolId: news.ipv6IpamPoolId,
              Ipv6NetmaskLength: news.ipv6NetmaskLength,
              Ipv6Native: false, // Explicitly set to false for now
              TagSpecifications: [
                {
                  ResourceType: "subnet",
                  Tags: createTagsList(allTags),
                },
              ],
              DryRun: false,
            })
            .pipe(
              Effect.retry({
                while: (e) => e._tag === "InvalidVpcID.NotFound",
                schedule: Schedule.exponential(100),
              }),
            );

          const subnetId = createResult.Subnet!.SubnetId! as SubnetId;
          yield* session.note(`Subnet created: ${subnetId}`);

          // 4. Modify subnet attributes if specified
          if (news.mapPublicIpOnLaunch !== undefined) {
            yield* ec2.modifySubnetAttribute({
              SubnetId: subnetId,
              MapPublicIpOnLaunch: { Value: news.mapPublicIpOnLaunch },
            });
          }

          if (news.assignIpv6AddressOnCreation !== undefined) {
            yield* ec2.modifySubnetAttribute({
              SubnetId: subnetId,
              AssignIpv6AddressOnCreation: {
                Value: news.assignIpv6AddressOnCreation,
              },
            });
          }

          if (news.enableDns64 !== undefined) {
            yield* ec2.modifySubnetAttribute({
              SubnetId: subnetId,
              EnableDns64: { Value: news.enableDns64 },
            });
          }

          if (
            news.enableResourceNameDnsARecordOnLaunch !== undefined ||
            news.enableResourceNameDnsAAAARecordOnLaunch !== undefined ||
            news.hostnameType !== undefined
          ) {
            yield* ec2.modifySubnetAttribute({
              SubnetId: subnetId,
              PrivateDnsHostnameTypeOnLaunch: news.hostnameType,
              EnableResourceNameDnsARecordOnLaunch:
                news.enableResourceNameDnsARecordOnLaunch !== undefined
                  ? { Value: news.enableResourceNameDnsARecordOnLaunch }
                  : undefined,
              EnableResourceNameDnsAAAARecordOnLaunch:
                news.enableResourceNameDnsAAAARecordOnLaunch !== undefined
                  ? { Value: news.enableResourceNameDnsAAAARecordOnLaunch }
                  : undefined,
            });
          }

          // 5. Wait for subnet to be available
          const subnet = yield* waitForSubnetAvailable(ec2, subnetId, session);

          // 6. Return attributes
          return {
            subnetId,
            subnetArn:
              subnet.SubnetArn! as SubnetAttrs<SubnetProps>["subnetArn"],
            cidrBlock: subnet.CidrBlock!,
            vpcId: news.vpcId,
            availabilityZone: subnet.AvailabilityZone!,
            availabilityZoneId: subnet.AvailabilityZoneId,
            state: subnet.State!,
            availableIpAddressCount: subnet.AvailableIpAddressCount ?? 0,
            mapPublicIpOnLaunch: subnet.MapPublicIpOnLaunch ?? false,
            assignIpv6AddressOnCreation:
              subnet.AssignIpv6AddressOnCreation ?? false,
            defaultForAz: subnet.DefaultForAz ?? false,
            ownerId: subnet.OwnerId,
            ipv6CidrBlockAssociationSet:
              subnet.Ipv6CidrBlockAssociationSet?.map((assoc) => ({
                associationId: assoc.AssociationId!,
                ipv6CidrBlock: assoc.Ipv6CidrBlock!,
                ipv6CidrBlockState: {
                  state: assoc.Ipv6CidrBlockState!.State!,
                  statusMessage: assoc.Ipv6CidrBlockState!.StatusMessage,
                },
              })),
            enableDns64: subnet.EnableDns64,
            ipv6Native: subnet.Ipv6Native,
            privateDnsNameOptionsOnLaunch: subnet.PrivateDnsNameOptionsOnLaunch
              ? {
                  hostnameType:
                    subnet.PrivateDnsNameOptionsOnLaunch.HostnameType,
                  enableResourceNameDnsARecord:
                    subnet.PrivateDnsNameOptionsOnLaunch
                      .EnableResourceNameDnsARecord,
                  enableResourceNameDnsAAAARecord:
                    subnet.PrivateDnsNameOptionsOnLaunch
                      .EnableResourceNameDnsAAAARecord,
                }
              : undefined,
          } satisfies SubnetAttrs<SubnetProps>;
        }),

        update: Effect.fn(function* ({ news, olds, output, session }) {
          const subnetId = output.subnetId;

          // Update MapPublicIpOnLaunch if changed
          if (news.mapPublicIpOnLaunch !== olds.mapPublicIpOnLaunch) {
            yield* ec2.modifySubnetAttribute({
              SubnetId: subnetId,
              MapPublicIpOnLaunch: { Value: news.mapPublicIpOnLaunch ?? false },
            });
            yield* session.note("Updated map public IP on launch");
          }

          // Update AssignIpv6AddressOnCreation if changed
          if (
            news.assignIpv6AddressOnCreation !==
            olds.assignIpv6AddressOnCreation
          ) {
            yield* ec2.modifySubnetAttribute({
              SubnetId: subnetId,
              AssignIpv6AddressOnCreation: {
                Value: news.assignIpv6AddressOnCreation ?? false,
              },
            });
            yield* session.note("Updated assign IPv6 address on creation");
          }

          // Update EnableDns64 if changed
          if (news.enableDns64 !== olds.enableDns64) {
            yield* ec2.modifySubnetAttribute({
              SubnetId: subnetId,
              EnableDns64: { Value: news.enableDns64 ?? false },
            });
            yield* session.note("Updated DNS64 setting");
          }

          // Update private DNS hostname settings if changed
          if (
            news.enableResourceNameDnsARecordOnLaunch !==
              olds.enableResourceNameDnsARecordOnLaunch ||
            news.enableResourceNameDnsAAAARecordOnLaunch !==
              olds.enableResourceNameDnsAAAARecordOnLaunch ||
            news.hostnameType !== olds.hostnameType
          ) {
            yield* ec2.modifySubnetAttribute({
              SubnetId: subnetId,
              PrivateDnsHostnameTypeOnLaunch: news.hostnameType,
              EnableResourceNameDnsARecordOnLaunch:
                news.enableResourceNameDnsARecordOnLaunch !== undefined
                  ? { Value: news.enableResourceNameDnsARecordOnLaunch }
                  : undefined,
              EnableResourceNameDnsAAAARecordOnLaunch:
                news.enableResourceNameDnsAAAARecordOnLaunch !== undefined
                  ? { Value: news.enableResourceNameDnsAAAARecordOnLaunch }
                  : undefined,
            });
            yield* session.note("Updated private DNS hostname settings");
          }

          // Note: Tag updates would go here if we support user tag changes

          return output; // Subnet attributes don't change from these updates
        }),

        delete: Effect.fn(function* ({ output, session }) {
          const subnetId = output.subnetId;

          yield* session.note(`Deleting subnet: ${subnetId}`);

          // 1. Attempt to delete subnet
          yield* ec2
            .deleteSubnet({
              SubnetId: subnetId,
              DryRun: false,
            })
            .pipe(
              Effect.tapError(Effect.logDebug),
              Effect.catchTag("InvalidSubnetID.NotFound", () => Effect.void),
              // Retry on dependency violations (resources still being deleted)
              Effect.retry({
                while: (e) => {
                  // DependencyViolation means there are still dependent resources
                  // This can happen if ENIs/instances are being deleted concurrently
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

          // 2. Wait for subnet to be fully deleted
          yield* waitForSubnetDeleted(ec2, subnetId, session);

          yield* session.note(`Subnet ${subnetId} deleted successfully`);
        }),
      } satisfies ProviderService<Subnet>;
    }),
  );

/**
 * Wait for subnet to be in available state
 */
const waitForSubnetAvailable = (
  ec2: EC2,
  subnetId: string,
  session?: ScopedPlanStatusSession,
) =>
  Effect.retry(
    Effect.gen(function* () {
      const result = yield* ec2
        .describeSubnets({ SubnetIds: [subnetId] })
        .pipe(
          Effect.catchTag("InvalidSubnetID.NotFound", () =>
            Effect.succeed({ Subnets: [] }),
          ),
        );
      const subnet = result.Subnets![0];

      if (subnet.State === "available") {
        return subnet;
      }

      // Still pending, fail to trigger retry
      return yield* Effect.fail(new Error("Subnet not yet available"));
    }),
    {
      schedule: Schedule.fixed(2000).pipe(
        // Check every 2 seconds
        Schedule.intersect(Schedule.recurs(30)), // Max 60 seconds
        Schedule.tapOutput(([, attempt]) =>
          session
            ? session.note(
                `Waiting for subnet to be available... (${(attempt + 1) * 2}s)`,
              )
            : Effect.void,
        ),
      ),
    },
  );

/**
 * Wait for subnet to be deleted
 */
const waitForSubnetDeleted = (
  ec2: EC2,
  subnetId: string,
  session: ScopedPlanStatusSession,
) =>
  Effect.gen(function* () {
    yield* Effect.retry(
      Effect.gen(function* () {
        const result = yield* ec2
          .describeSubnets({ SubnetIds: [subnetId] })
          .pipe(
            Effect.tapError(Effect.logDebug),
            Effect.catchTag("InvalidSubnetID.NotFound", () =>
              Effect.succeed({ Subnets: [] }),
            ),
          );

        if (!result.Subnets || result.Subnets.length === 0) {
          return; // Successfully deleted
        }

        // Still exists, fail to trigger retry
        return yield* Effect.fail(new Error("Subnet still exists"));
      }),
      {
        schedule: Schedule.fixed(2000).pipe(
          // Check every 2 seconds
          Schedule.intersect(Schedule.recurs(15)), // Max 30 seconds
          Schedule.tapOutput(([, attempt]) =>
            session.note(
              `Waiting for subnet deletion... (${(attempt + 1) * 2}s)`,
            ),
          ),
        ),
      },
    );
  });
