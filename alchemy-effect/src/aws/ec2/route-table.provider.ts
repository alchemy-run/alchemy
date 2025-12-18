import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

import type { EC2 } from "itty-aws/ec2";

import type { ScopedPlanStatusSession } from "../../cli/service.ts";
import type { ProviderService } from "../../provider.ts";
import { createTagger, createTagsList } from "../../tags.ts";
import { Account } from "../account.ts";
import { Region } from "../region.ts";
import { EC2Client } from "./client.ts";
import {
  RouteTable,
  type RouteTableAttrs,
  type RouteTableId,
  type RouteTableProps,
} from "./route-table.ts";

export const routeTableProvider = () =>
  RouteTable.provider.effect(
    Effect.gen(function* () {
      const ec2 = yield* EC2Client;
      const region = yield* Region;
      const accountId = yield* Account;
      const tagged = yield* createTagger();

      return {
        stables: ["routeTableId", "ownerId", "routeTableArn", "vpcId"],
        diff: Effect.fn(function* ({ news, olds }) {
          // VpcId change requires replacement
          if (olds.vpcId !== news.vpcId) {
            return { action: "replace" };
          }
          // Tags can be updated in-place
        }),

        create: Effect.fn(function* ({ id, news, session }) {
          // 1. Prepare tags
          const alchemyTags = tagged(id);
          const userTags = news.tags ?? {};
          const allTags = { ...alchemyTags, ...userTags };

          // 2. Call CreateRouteTable
          const createResult = yield* ec2
            .createRouteTable({
              VpcId: news.vpcId,
              TagSpecifications: [
                {
                  ResourceType: "route-table",
                  Tags: createTagsList(allTags),
                },
              ],
              DryRun: false,
            })
            .pipe(
              Effect.retry({
                // Retry if VPC is not yet available
                while: (e) => e._tag === "InvalidVpcID.NotFound",
                schedule: Schedule.exponential(100),
              }),
            );

          const routeTableId = createResult.RouteTable!
            .RouteTableId! as RouteTableId;
          yield* session.note(`Route table created: ${routeTableId}`);

          // 3. Describe to get full details
          const routeTable = yield* describeRouteTable(
            ec2,
            routeTableId,
            session,
          );

          // 4. Return attributes
          return {
            routeTableId,
            routeTableArn:
              `arn:aws:ec2:${region}:${accountId}:route-table/${routeTableId}` as RouteTableAttrs<RouteTableProps>["routeTableArn"],
            vpcId: news.vpcId,
            ownerId: routeTable.OwnerId,
            associations: routeTable.Associations?.map((assoc) => ({
              main: assoc.Main ?? false,
              routeTableAssociationId: assoc.RouteTableAssociationId,
              routeTableId: assoc.RouteTableId,
              subnetId: assoc.SubnetId,
              gatewayId: assoc.GatewayId,
              associationState: assoc.AssociationState
                ? {
                    state: assoc.AssociationState.State!,
                    statusMessage: assoc.AssociationState.StatusMessage,
                  }
                : undefined,
            })),
            routes: routeTable.Routes?.map((route) => ({
              destinationCidrBlock: route.DestinationCidrBlock,
              destinationIpv6CidrBlock: route.DestinationIpv6CidrBlock,
              destinationPrefixListId: route.DestinationPrefixListId,
              egressOnlyInternetGatewayId: route.EgressOnlyInternetGatewayId,
              gatewayId: route.GatewayId,
              instanceId: route.InstanceId,
              instanceOwnerId: route.InstanceOwnerId,
              natGatewayId: route.NatGatewayId,
              transitGatewayId: route.TransitGatewayId,
              localGatewayId: route.LocalGatewayId,
              carrierGatewayId: route.CarrierGatewayId,
              networkInterfaceId: route.NetworkInterfaceId,
              origin: route.Origin!,
              state: route.State!,
              vpcPeeringConnectionId: route.VpcPeeringConnectionId,
              coreNetworkArn: route.CoreNetworkArn,
            })),
            propagatingVgws: routeTable.PropagatingVgws?.map((vgw) => ({
              gatewayId: vgw.GatewayId!,
            })),
          } satisfies RouteTableAttrs<RouteTableProps>;
        }),

        update: Effect.fn(function* ({ news, olds, output, session }) {
          const routeTableId = output.routeTableId;

          // Handle tag updates
          if (
            JSON.stringify(news.tags ?? {}) !== JSON.stringify(olds.tags ?? {})
          ) {
            const alchemyTags = tagged(output.routeTableId);
            const userTags = news.tags ?? {};
            const allTags = { ...alchemyTags, ...userTags };

            // Delete old tags that are no longer present
            const oldTagKeys = Object.keys(olds.tags ?? {});
            const newTagKeys = Object.keys(news.tags ?? {});
            const tagsToDelete = oldTagKeys.filter(
              (key) => !newTagKeys.includes(key),
            );

            if (tagsToDelete.length > 0) {
              yield* ec2.deleteTags({
                Resources: [routeTableId],
                Tags: tagsToDelete.map((key) => ({ Key: key })),
              });
            }

            // Create/update tags
            yield* ec2.createTags({
              Resources: [routeTableId],
              Tags: createTagsList(allTags),
            });

            yield* session.note("Updated tags");
          }

          // Re-describe to get current state
          const routeTable = yield* describeRouteTable(
            ec2,
            routeTableId,
            session,
          );

          return {
            ...output,
            associations: routeTable.Associations?.map((assoc) => ({
              main: assoc.Main ?? false,
              routeTableAssociationId: assoc.RouteTableAssociationId,
              routeTableId: assoc.RouteTableId,
              subnetId: assoc.SubnetId,
              gatewayId: assoc.GatewayId,
              associationState: assoc.AssociationState
                ? {
                    state: assoc.AssociationState.State!,
                    statusMessage: assoc.AssociationState.StatusMessage,
                  }
                : undefined,
            })),
            routes: routeTable.Routes?.map((route) => ({
              destinationCidrBlock: route.DestinationCidrBlock,
              destinationIpv6CidrBlock: route.DestinationIpv6CidrBlock,
              destinationPrefixListId: route.DestinationPrefixListId,
              egressOnlyInternetGatewayId: route.EgressOnlyInternetGatewayId,
              gatewayId: route.GatewayId,
              instanceId: route.InstanceId,
              instanceOwnerId: route.InstanceOwnerId,
              natGatewayId: route.NatGatewayId,
              transitGatewayId: route.TransitGatewayId,
              localGatewayId: route.LocalGatewayId,
              carrierGatewayId: route.CarrierGatewayId,
              networkInterfaceId: route.NetworkInterfaceId,
              origin: route.Origin!,
              state: route.State!,
              vpcPeeringConnectionId: route.VpcPeeringConnectionId,
              coreNetworkArn: route.CoreNetworkArn,
            })),
            propagatingVgws: routeTable.PropagatingVgws?.map((vgw) => ({
              gatewayId: vgw.GatewayId!,
            })),
          };
        }),

        delete: Effect.fn(function* ({ output, session }) {
          const routeTableId = output.routeTableId;

          yield* session.note(`Deleting route table: ${routeTableId}`);

          // 1. Attempt to delete route table
          yield* ec2
            .deleteRouteTable({
              RouteTableId: routeTableId,
              DryRun: false,
            })
            .pipe(
              Effect.tapError(Effect.logDebug),
              Effect.catchTag(
                "InvalidRouteTableID.NotFound",
                () => Effect.void,
              ),
              // Retry on dependency violations (associations still being deleted)
              Effect.retry({
                // DependencyViolation means there are still dependent resources
                while: (e) => {
                  return e._tag === "DependencyViolation";
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

          // 2. Wait for route table to be fully deleted
          yield* waitForRouteTableDeleted(ec2, routeTableId, session);

          yield* session.note(
            `Route table ${routeTableId} deleted successfully`,
          );
        }),
      } satisfies ProviderService<RouteTable>;
    }),
  );

/**
 * Describe a route table by ID
 */
const describeRouteTable = (
  ec2: EC2,
  routeTableId: string,
  _session?: ScopedPlanStatusSession,
) =>
  Effect.gen(function* () {
    const result = yield* ec2
      .describeRouteTables({ RouteTableIds: [routeTableId] })
      .pipe(
        Effect.catchTag("InvalidRouteTableID.NotFound", () =>
          Effect.succeed({ RouteTables: [] }),
        ),
      );

    const routeTable = result.RouteTables?.[0];
    if (!routeTable) {
      return yield* Effect.fail(new Error("Route table not found"));
    }
    return routeTable;
  });

/**
 * Wait for route table to be deleted
 */
const waitForRouteTableDeleted = (
  ec2: EC2,
  routeTableId: string,
  session: ScopedPlanStatusSession,
) =>
  Effect.gen(function* () {
    yield* Effect.retry(
      Effect.gen(function* () {
        const result = yield* ec2
          .describeRouteTables({ RouteTableIds: [routeTableId] })
          .pipe(
            Effect.tapError(Effect.logDebug),
            Effect.catchTag("InvalidRouteTableID.NotFound", () =>
              Effect.succeed({ RouteTables: [] }),
            ),
          );

        if (!result.RouteTables || result.RouteTables.length === 0) {
          return; // Successfully deleted
        }

        // Still exists, fail to trigger retry
        return yield* Effect.fail(new Error("Route table still exists"));
      }),
      {
        schedule: Schedule.fixed(2000).pipe(
          // Check every 2 seconds
          Schedule.intersect(Schedule.recurs(15)), // Max 30 seconds
          Schedule.tapOutput(([, attempt]) =>
            session.note(
              `Waiting for route table deletion... (${(attempt + 1) * 2}s)`,
            ),
          ),
        ),
      },
    );
  });
