import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

import type { ScopedPlanStatusSession } from "../../cli/service.ts";
import type { ProviderService } from "../../provider.ts";
import { EC2Client } from "./client.ts";
import {
  RouteTableAssociation,
  type RouteTableAssociationAttrs,
  type RouteTableAssociationId,
  type RouteTableAssociationProps,
} from "./route-table-association.ts";

export const routeTableAssociationProvider = () =>
  RouteTableAssociation.provider.effect(
    Effect.gen(function* () {
      const ec2 = yield* EC2Client;

      return {
        stables: ["associationId", "subnetId", "gatewayId"],
        diff: Effect.fn(function* ({ news, olds }) {
          // Subnet/Gateway change requires replacement (use ReplaceRouteTableAssociation internally)
          if (olds.subnetId !== news.subnetId) {
            return { action: "replace" };
          }
          if (olds.gatewayId !== news.gatewayId) {
            return { action: "replace" };
          }
          // Route table change can be done via ReplaceRouteTableAssociation
        }),

        create: Effect.fn(function* ({ news, session }) {
          // Call AssociateRouteTable
          const result = yield* ec2
            .associateRouteTable({
              RouteTableId: news.routeTableId,
              SubnetId: news.subnetId,
              GatewayId: news.gatewayId,
              DryRun: false,
            })
            .pipe(
              Effect.retry({
                // Retry if route table or subnet/gateway is not yet available
                while: (e) =>
                  e._tag === "InvalidRouteTableID.NotFound" ||
                  e._tag === "InvalidSubnetID.NotFound",
                schedule: Schedule.exponential(100),
              }),
            );

          const associationId =
            result.AssociationId! as RouteTableAssociationId;
          yield* session.note(
            `Route table association created: ${associationId}`,
          );

          // Wait for association to be associated
          yield* waitForAssociationState(
            ec2,
            news.routeTableId,
            associationId,
            "associated",
            session,
          );

          // Return attributes
          return {
            associationId,
            routeTableId: news.routeTableId,
            subnetId: news.subnetId,
            gatewayId: news.gatewayId,
            associationState: {
              state: result.AssociationState?.State ?? "associated",
              statusMessage: result.AssociationState?.StatusMessage,
            },
          } satisfies RouteTableAssociationAttrs<RouteTableAssociationProps>;
        }),

        update: Effect.fn(function* ({ news, olds, output, session }) {
          // If route table changed, use ReplaceRouteTableAssociation
          if (news.routeTableId !== olds.routeTableId) {
            const result = yield* ec2.replaceRouteTableAssociation({
              AssociationId: output.associationId,
              RouteTableId: news.routeTableId,
              DryRun: false,
            });

            const newAssociationId =
              result.NewAssociationId! as RouteTableAssociationId;
            yield* session.note(
              `Route table association replaced: ${newAssociationId}`,
            );

            // Wait for new association to be associated
            yield* waitForAssociationState(
              ec2,
              news.routeTableId,
              newAssociationId,
              "associated",
              session,
            );

            return {
              associationId: newAssociationId,
              routeTableId: news.routeTableId,
              subnetId: news.subnetId,
              gatewayId: news.gatewayId,
              associationState: {
                state: result.AssociationState?.State ?? "associated",
                statusMessage: result.AssociationState?.StatusMessage,
              },
            };
          }

          // No changes needed
          return output;
        }),

        delete: Effect.fn(function* ({ output, session }) {
          yield* session.note(
            `Deleting route table association: ${output.associationId}`,
          );

          // Disassociate the route table
          yield* ec2
            .disassociateRouteTable({
              AssociationId: output.associationId,
              DryRun: false,
            })
            .pipe(
              Effect.tapError(Effect.log),
              Effect.catchTag(
                "InvalidAssociationID.NotFound",
                () => Effect.void,
              ),
            );

          yield* session.note(
            `Route table association ${output.associationId} deleted successfully`,
          );
        }),
      } satisfies ProviderService<RouteTableAssociation>;
    }),
  );

/**
 * Wait for association to reach a specific state
 */
const waitForAssociationState = (
  ec2: import("itty-aws/ec2").EC2,
  routeTableId: string,
  associationId: string,
  targetState:
    | "associating"
    | "associated"
    | "disassociating"
    | "disassociated",
  session?: ScopedPlanStatusSession,
) =>
  Effect.retry(
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

      const association = routeTable.Associations?.find(
        (a) => a.RouteTableAssociationId === associationId,
      );

      if (!association) {
        // Association might not exist yet, retry
        return yield* Effect.fail(new Error("Association not found"));
      }

      if (association.AssociationState?.State === targetState) {
        return;
      }

      if (association.AssociationState?.State === "failed") {
        return yield* Effect.fail(
          new Error(
            `Association failed: ${association.AssociationState.StatusMessage}`,
          ),
        );
      }

      // Still in progress, fail to trigger retry
      return yield* Effect.fail(
        new Error(`Association state: ${association.AssociationState?.State}`),
      );
    }),
    {
      schedule: Schedule.fixed(1000).pipe(
        // Check every second
        Schedule.intersect(Schedule.recurs(30)), // Max 30 seconds
        Schedule.tapOutput(([, attempt]) =>
          session
            ? session.note(
                `Waiting for association to be ${targetState}... (${attempt + 1}s)`,
              )
            : Effect.void,
        ),
      ),
    },
  );
