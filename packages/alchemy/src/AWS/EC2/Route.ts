import type * as EC2 from "@distilled.cloud/aws/ec2";
import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { isResolved, somePropsAreDifferent } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import type { RouteTableId } from "./RouteTable.ts";

export interface RouteProps {
  /**
   * The ID of the route table where the route will be added.
   * Required.
   */
  routeTableId: RouteTableId;

  /**
   * The IPv4 CIDR block used for the destination match.
   * Either destinationCidrBlock, destinationIpv6CidrBlock, or destinationPrefixListId is required.
   * @example "0.0.0.0/0"
   */
  destinationCidrBlock?: string;

  /**
   * The IPv6 CIDR block used for the destination match.
   * Either destinationCidrBlock, destinationIpv6CidrBlock, or destinationPrefixListId is required.
   * @example "::/0"
   */
  destinationIpv6CidrBlock?: string;

  /**
   * The ID of a prefix list used for the destination match.
   * Either destinationCidrBlock, destinationIpv6CidrBlock, or destinationPrefixListId is required.
   */
  destinationPrefixListId?: string;

  // ---- Target properties (exactly one required) ----

  /**
   * The ID of an internet gateway or virtual private gateway.
   */
  gatewayId?: string;

  /**
   * The ID of a NAT gateway.
   */
  natGatewayId?: string;

  /**
   * The ID of a NAT instance in your VPC.
   * This operation fails unless exactly one network interface is attached.
   */
  instanceId?: string;

  /**
   * The ID of a network interface.
   */
  networkInterfaceId?: string;

  /**
   * The ID of a VPC peering connection.
   */
  vpcPeeringConnectionId?: string;

  /**
   * The ID of a transit gateway.
   */
  transitGatewayId?: string;

  /**
   * The ID of a local gateway.
   */
  localGatewayId?: string;

  /**
   * The ID of a carrier gateway.
   * Use for Wavelength Zones only.
   */
  carrierGatewayId?: string;

  /**
   * The ID of an egress-only internet gateway.
   * IPv6 traffic only.
   */
  egressOnlyInternetGatewayId?: string;

  /**
   * The Amazon Resource Name (ARN) of the core network.
   */
  coreNetworkArn?: string;

  /**
   * The ID of a VPC endpoint for Gateway Load Balancer.
   */
  vpcEndpointId?: string;
}

export interface Route extends Resource<
  "AWS.EC2.Route",
  RouteProps,
  {
    routeTableId: RouteTableId;
    destinationCidrBlock?: string | undefined;
    destinationIpv6CidrBlock?: string | undefined;
    destinationPrefixListId?: string | undefined;
    origin: EC2.RouteOrigin;
    state: EC2.RouteState;
    gatewayId?: string;
    natGatewayId?: string;
    instanceId?: string;
    networkInterfaceId?: string;
    vpcPeeringConnectionId?: string;
    transitGatewayId?: string;
    localGatewayId?: string;
    carrierGatewayId?: string;
    egressOnlyInternetGatewayId?: string;
    coreNetworkArn?: string;
  },
  never,
  Providers
> {}
export const Route = Resource<Route>("AWS.EC2.Route");

export const RouteProvider = () =>
  Provider.effect(
    Route,
    Effect.gen(function* () {
      return {
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return;
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

        reconcile: Effect.fn(function* ({ news, session }) {
          const dest =
            news.destinationCidrBlock ||
            news.destinationIpv6CidrBlock ||
            news.destinationPrefixListId ||
            "unknown";

          const targetParams = {
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
          } as const;

          // Observe — Routes are identified by (routeTableId, destination).
          // Look the route up in the route table to decide between create
          // (missing) and replaceRoute (target drift).
          const observed = yield* describeRoute(news.routeTableId, news);

          // Ensure / Sync — CreateRoute when missing, ReplaceRoute swaps the
          // target on an existing route in-place.
          if (observed === undefined) {
            yield* ec2
              .createRoute({
                ...targetParams,
                VpcEndpointId: news.vpcEndpointId,
              })
              .pipe(
                Effect.retry({
                  while: (e) => e._tag === "InvalidRouteTableID.NotFound",
                  schedule: Schedule.exponential(100),
                }),
              );
            yield* session.note(`Route created: ${dest}`);
          } else {
            yield* ec2.replaceRoute(targetParams).pipe(
              Effect.tapError(Effect.log),
              Effect.retry({
                while: (e) => e._tag === "InvalidRouteTableID.NotFound",
                schedule: Schedule.exponential(100),
              }),
            );
            yield* session.note(`Route target updated: ${dest}`);
          }

          // Re-read final state.
          const route = yield* describeRoute(news.routeTableId, news);
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
          };
        }),

        // Routes are entries embedded inside RouteTables. Enumerate by
        // flattening describeRouteTables -> RouteTables[].Routes[], pairing each
        // route with its parent routeTableId. Skip the implicit local route
        // (GatewayId === "local", Origin "CreateRouteTable") that AWS creates
        // automatically and that this provider does not manage.
        list: () =>
          Effect.gen(function* () {
            return yield* ec2.describeRouteTables.pages({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) =>
                  (page.RouteTables ?? []).flatMap((rt) => {
                    const routeTableId = rt.RouteTableId;
                    if (routeTableId === undefined) return [];
                    return (rt.Routes ?? [])
                      .filter((r) => r.GatewayId !== "local")
                      .map((r) => ({
                        routeTableId: routeTableId as RouteTableId,
                        destinationCidrBlock: r.DestinationCidrBlock,
                        destinationIpv6CidrBlock: r.DestinationIpv6CidrBlock,
                        destinationPrefixListId: r.DestinationPrefixListId,
                        origin: r.Origin ?? "CreateRoute",
                        state: r.State ?? "active",
                        gatewayId: r.GatewayId,
                        natGatewayId: r.NatGatewayId,
                        instanceId: r.InstanceId,
                        networkInterfaceId: r.NetworkInterfaceId,
                        vpcPeeringConnectionId: r.VpcPeeringConnectionId,
                        transitGatewayId: r.TransitGatewayId,
                        localGatewayId: r.LocalGatewayId,
                        carrierGatewayId: r.CarrierGatewayId,
                        egressOnlyInternetGatewayId:
                          r.EgressOnlyInternetGatewayId,
                        coreNetworkArn: r.CoreNetworkArn,
                      }));
                  }),
                ),
              ),
            );
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
