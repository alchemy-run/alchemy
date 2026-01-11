import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

import * as ec2 from "distilled-aws/ec2";

import { somePropsAreDifferent } from "../../diff.ts";
import { Route, type RouteAttrs, type RouteProps } from "./route.ts";

export const routeProvider = () =>
  Route.provider.effect(
    Effect.gen(function* () {
      return {
        diff: Effect.fn(function* ({ news, olds }) {
          // Route table change requires replacement
          if (olds.routeTableId !== news.routeTableId) {
            return { action: "replace" };
          }

          // Destination change requires replacement
          if (
            somePropsAreDifferent(olds, news, [
              "destinationCidrBlock",
              "destinationIpv6CidrBlock",
              "destinationPrefixListId",
            ])
          ) {
            return { action: "replace" };
          }

          // Target change can be done via ReplaceRoute (update)
        }),

        create: Effect.fn(function* ({ news, session }) {
          // Call CreateRoute
          yield* ec2
            .createRoute({
              RouteTableId: news.routeTableId,
              DestinationCidrBlock: news.destinationCidrBlock,
              DestinationIpv6CidrBlock: news.destinationIpv6CidrBlock,
              DestinationPrefixListId: news.destinationPrefixListId,
              GatewayId: news.gatewayId,
              NatGatewayId: news.natGatewayId,
              InstanceId: news.instanceId,
              NetworkInterfaceId: news.networkInterfaceId,
              VpcPeeringConnectionId: news.vpcPeeringConnectionId,
              TransitGatewayId: news.transitGatewayId,
              LocalGatewayId: news.localGatewayId,
              CarrierGatewayId: news.carrierGatewayId,
              EgressOnlyInternetGatewayId: news.egressOnlyInternetGatewayId,
              CoreNetworkArn: news.coreNetworkArn,
              VpcEndpointId: news.vpcEndpointId,
              DryRun: false,
            })
            .pipe(
              Effect.retry({
                // Retry if route table is not yet available
                while: (e) => e._tag === "InvalidRouteTableID.NotFound",
                schedule: Schedule.exponential(100),
              }),
            );

          const dest =
            news.destinationCidrBlock ||
            news.destinationIpv6CidrBlock ||
            news.destinationPrefixListId ||
            "unknown";
          yield* session.note(`Route created: ${dest}`);

          // Describe to get route details
          const route = yield* describeRoute(news.routeTableId, news);

          // Return attributes
          return {
            routeTableId: news.routeTableId,
            destinationCidrBlock: news.destinationCidrBlock,
            destinationIpv6CidrBlock: news.destinationIpv6CidrBlock,
            destinationPrefixListId: news.destinationPrefixListId,
            origin: route?.Origin ?? "CreateRoute",
            state: route?.State ?? "active",
            gatewayId: route?.GatewayId,
            natGatewayId: route?.NatGatewayId,
            instanceId: route?.InstanceId,
            networkInterfaceId: route?.NetworkInterfaceId,
            vpcPeeringConnectionId: route?.VpcPeeringConnectionId,
            transitGatewayId: route?.TransitGatewayId,
            localGatewayId: route?.LocalGatewayId,
            carrierGatewayId: route?.CarrierGatewayId,
            egressOnlyInternetGatewayId: route?.EgressOnlyInternetGatewayId,
            coreNetworkArn: route?.CoreNetworkArn,
          } satisfies RouteAttrs<RouteProps>;
        }),

        update: Effect.fn(function* ({ news, output, session }) {
          // Use ReplaceRoute to update the target
          yield* ec2
            .replaceRoute({
              RouteTableId: news.routeTableId,
              DestinationCidrBlock: news.destinationCidrBlock,
              DestinationIpv6CidrBlock: news.destinationIpv6CidrBlock,
              DestinationPrefixListId: news.destinationPrefixListId,
              GatewayId: news.gatewayId,
              NatGatewayId: news.natGatewayId,
              InstanceId: news.instanceId,
              NetworkInterfaceId: news.networkInterfaceId,
              VpcPeeringConnectionId: news.vpcPeeringConnectionId,
              TransitGatewayId: news.transitGatewayId,
              LocalGatewayId: news.localGatewayId,
              CarrierGatewayId: news.carrierGatewayId,
              EgressOnlyInternetGatewayId: news.egressOnlyInternetGatewayId,
              CoreNetworkArn: news.coreNetworkArn,
              DryRun: false,
            })
            .pipe(
              Effect.tapError(Effect.log),
              Effect.retry({
                while: (e) => e._tag === "InvalidRouteTableID.NotFound",
                schedule: Schedule.exponential(100),
              }),
            );

          yield* session.note("Route target updated");

          // Describe to get updated route details
          const route = yield* describeRoute(news.routeTableId, news);

          return {
            ...output,
            origin: route?.Origin ?? output.origin,
            state: route?.State ?? output.state,
            gatewayId: route?.GatewayId,
            natGatewayId: route?.NatGatewayId,
            instanceId: route?.InstanceId,
            networkInterfaceId: route?.NetworkInterfaceId,
            vpcPeeringConnectionId: route?.VpcPeeringConnectionId,
            transitGatewayId: route?.TransitGatewayId,
            localGatewayId: route?.LocalGatewayId,
            carrierGatewayId: route?.CarrierGatewayId,
            egressOnlyInternetGatewayId: route?.EgressOnlyInternetGatewayId,
            coreNetworkArn: route?.CoreNetworkArn,
          };
        }),

        delete: Effect.fn(function* ({ output, session }) {
          const dest =
            output.destinationCidrBlock ||
            output.destinationIpv6CidrBlock ||
            output.destinationPrefixListId ||
            "unknown";

          yield* session.note(`Deleting route: ${dest}`);

          // Delete the route
          yield* ec2
            .deleteRoute({
              RouteTableId: output.routeTableId,
              DestinationCidrBlock: output.destinationCidrBlock,
              DestinationIpv6CidrBlock: output.destinationIpv6CidrBlock,
              DestinationPrefixListId: output.destinationPrefixListId,
              DryRun: false,
            })
            .pipe(
              Effect.tapError(Effect.logDebug),
              Effect.catchTag("InvalidRoute.NotFound", () => Effect.void),
              Effect.catchTag(
                "InvalidRouteTableID.NotFound",
                () => Effect.void,
              ),
            );

          yield* session.note(`Route ${dest} deleted successfully`);
        }),
      };
    }),
  );

/**
 * Find a specific route in a route table
 */
const describeRoute = (routeTableId: string, props: RouteProps) =>
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
      return undefined;
    }

    // Find the matching route
    const route = routeTable.Routes?.find((r) => {
      if (props.destinationCidrBlock) {
        return r.DestinationCidrBlock === props.destinationCidrBlock;
      }
      if (props.destinationIpv6CidrBlock) {
        return r.DestinationIpv6CidrBlock === props.destinationIpv6CidrBlock;
      }
      if (props.destinationPrefixListId) {
        return r.DestinationPrefixListId === props.destinationPrefixListId;
      }
      return false;
    });

    return route;
  });
