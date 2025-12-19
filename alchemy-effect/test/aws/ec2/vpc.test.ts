import * as AWS from "@/aws";
import * as EC2 from "@/aws/ec2";
import {
  apply as _apply,
  applyPlan,
  destroy,
  plan,
  printPlan,
  type AnyResource,
  type AnyService,
} from "@/index";
import * as Output from "@/output";
import { test } from "@/test";
import { expect } from "@effect/vitest";
import { Data, Duration, LogLevel, Schedule } from "effect";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";

const logLevel = Logger.withMinimumLogLevel(
  process.env.DEBUG ? LogLevel.Debug : LogLevel.Info,
);

const apply = (<const Resources extends (AnyService | AnyResource)[] = never>(
  ...resources: Resources
) =>
  plan(...resources).pipe(
    Effect.tap((plan) => Effect.log(printPlan(plan))),
    Effect.flatMap(applyPlan),
  )) as typeof _apply;

test(
  "VPC evolution: from simple to complex",
  {
    timeout: 1_000_000,
  },
  Effect.gen(function* () {
    const ec2 = yield* EC2.EC2Client;

    yield* destroy();

    // Get available AZs for multi-AZ stages
    const azResult = yield* ec2.describeAvailabilityZones({});
    const availableAzs =
      azResult.AvailabilityZones?.filter((az) => az.State === "available") ??
      [];
    const az1 = availableAzs[0]?.ZoneName!;
    const az2 = availableAzs[1]?.ZoneName!;

    // =========================================================================
    // STAGE 1: Bare Minimum VPC
    // User starts with just a VPC - the most basic setup
    // =========================================================================
    yield* Effect.log("=== Stage 1: Bare Minimum VPC ===");
    {
      class MyVpc extends EC2.Vpc("MyVpc", {
        cidrBlock: "10.0.0.0/16",
      }) {}

      const stack = yield* apply(MyVpc);

      // Verify VPC was created
      expect(stack.MyVpc.vpcId).toMatch(/^vpc-/);
      expect(stack.MyVpc.cidrBlock).toEqual("10.0.0.0/16");
      expect(stack.MyVpc.state).toEqual("available");

      const vpcResult = yield* ec2.describeVpcs({
        VpcIds: [stack.MyVpc.vpcId],
      });
      expect(vpcResult.Vpcs?.[0]?.CidrBlock).toEqual("10.0.0.0/16");
    }

    // =========================================================================
    // STAGE 2: Add Internet Connectivity
    // User needs public internet access - add IGW, public subnet, route table
    // Tests: VPC update (DNS settings), IGW create, Subnet create, Route create
    // =========================================================================
    yield* Effect.log("=== Stage 2: Add Internet Connectivity ===");
    {
      class MyVpc extends EC2.Vpc("MyVpc", {
        cidrBlock: "10.0.0.0/16",
        enableDnsSupport: true,
        enableDnsHostnames: true,
      }) {}

      class InternetGateway extends EC2.InternetGateway("InternetGateway", {
        vpcId: Output.of(MyVpc).vpcId,
      }) {}

      class PublicSubnet1 extends EC2.Subnet("PublicSubnet1", {
        vpcId: Output.of(MyVpc).vpcId,
        cidrBlock: "10.0.1.0/24",
        availabilityZone: az1,
        mapPublicIpOnLaunch: true,
      }) {}

      class PublicRouteTable extends EC2.RouteTable("PublicRouteTable", {
        vpcId: Output.of(MyVpc).vpcId,
      }) {}

      class InternetRoute extends EC2.Route("InternetRoute", {
        routeTableId: Output.of(PublicRouteTable).routeTableId,
        destinationCidrBlock: "0.0.0.0/0",
        gatewayId: Output.of(InternetGateway).internetGatewayId,
      }) {}

      class PublicSubnet1Association extends EC2.RouteTableAssociation(
        "PublicSubnet1Association",
        {
          routeTableId: Output.of(PublicRouteTable).routeTableId,
          subnetId: Output.of(PublicSubnet1).subnetId,
        },
      ) {}

      const stack = yield* apply(
        MyVpc,
        InternetGateway,
        PublicSubnet1,
        PublicRouteTable,
        InternetRoute,
        PublicSubnet1Association,
      );

      // Verify IGW
      expect(stack.InternetGateway.internetGatewayId).toMatch(/^igw-/);
      expect(stack.InternetGateway.vpcId).toEqual(stack.MyVpc.vpcId);

      // Verify public subnet
      expect(stack.PublicSubnet1.subnetId).toMatch(/^subnet-/);
      expect(stack.PublicSubnet1.mapPublicIpOnLaunch).toEqual(true);
      expect(stack.PublicSubnet1.availabilityZone).toEqual(az1);

      // Verify route to IGW
      expect(stack.InternetRoute.state).toEqual("active");
      expect(stack.InternetRoute.gatewayId).toEqual(
        stack.InternetGateway.internetGatewayId,
      );

      // Verify association
      expect(stack.PublicSubnet1Association.associationId).toMatch(
        /^rtbassoc-/,
      );
    }

    // =========================================================================
    // STAGE 3: Add Private Subnet
    // User needs private resources (databases, internal services)
    // Tests: Adding private subnet with separate route table (no internet)
    // =========================================================================
    yield* Effect.log("=== Stage 3: Add Private Subnet ===");
    {
      class MyVpc extends EC2.Vpc("MyVpc", {
        cidrBlock: "10.0.0.0/16",
        enableDnsSupport: true,
        enableDnsHostnames: true,
      }) {}

      class InternetGateway extends EC2.InternetGateway("InternetGateway", {
        vpcId: Output.of(MyVpc).vpcId,
      }) {}

      class PublicSubnet1 extends EC2.Subnet("PublicSubnet1", {
        vpcId: Output.of(MyVpc).vpcId,
        cidrBlock: "10.0.1.0/24",
        availabilityZone: az1,
        mapPublicIpOnLaunch: true,
      }) {}

      class PrivateSubnet1 extends EC2.Subnet("PrivateSubnet1", {
        vpcId: Output.of(MyVpc).vpcId,
        cidrBlock: "10.0.10.0/24",
        availabilityZone: az1,
      }) {}

      class PublicRouteTable extends EC2.RouteTable("PublicRouteTable", {
        vpcId: Output.of(MyVpc).vpcId,
      }) {}

      class PrivateRouteTable extends EC2.RouteTable("PrivateRouteTable", {
        vpcId: Output.of(MyVpc).vpcId,
      }) {}

      class InternetRoute extends EC2.Route("InternetRoute", {
        routeTableId: Output.of(PublicRouteTable).routeTableId,
        destinationCidrBlock: "0.0.0.0/0",
        gatewayId: Output.of(InternetGateway).internetGatewayId,
      }) {}

      class PublicSubnet1Association extends EC2.RouteTableAssociation(
        "PublicSubnet1Association",
        {
          routeTableId: Output.of(PublicRouteTable).routeTableId,
          subnetId: Output.of(PublicSubnet1).subnetId,
        },
      ) {}

      class PrivateSubnet1Association extends EC2.RouteTableAssociation(
        "PrivateSubnet1Association",
        {
          routeTableId: Output.of(PrivateRouteTable).routeTableId,
          subnetId: Output.of(PrivateSubnet1).subnetId,
        },
      ) {}

      const stack = yield* apply(
        MyVpc,
        InternetGateway,
        PublicSubnet1,
        PrivateSubnet1,
        PublicRouteTable,
        PrivateRouteTable,
        InternetRoute,
        PublicSubnet1Association,
        PrivateSubnet1Association,
      );

      // Verify private subnet
      expect(stack.PrivateSubnet1.subnetId).toMatch(/^subnet-/);
      expect(stack.PrivateSubnet1.mapPublicIpOnLaunch).toBeFalsy();

      // Verify private route table has NO internet route
      const privateRtResult = yield* ec2.describeRouteTables({
        RouteTableIds: [stack.PrivateRouteTable.routeTableId],
      });
      const privateRoutes = privateRtResult.RouteTables?.[0]?.Routes ?? [];
      const privateInternetRoute = privateRoutes.find(
        (r) => r.DestinationCidrBlock === "0.0.0.0/0",
      );
      expect(privateInternetRoute).toBeUndefined();
    }

    // =========================================================================
    // STAGE 4: Multi-AZ Expansion
    // User needs high availability - add subnets in second AZ
    // Tests: Adding subnets in second AZ, sharing route tables
    // =========================================================================
    yield* Effect.log("=== Stage 4: Multi-AZ Expansion ===");
    {
      class MyVpc extends EC2.Vpc("MyVpc", {
        cidrBlock: "10.0.0.0/16",
        enableDnsSupport: true,
        enableDnsHostnames: true,
      }) {}

      class InternetGateway extends EC2.InternetGateway("InternetGateway", {
        vpcId: Output.of(MyVpc).vpcId,
      }) {}

      // AZ1 subnets
      class PublicSubnet1 extends EC2.Subnet("PublicSubnet1", {
        vpcId: Output.of(MyVpc).vpcId,
        cidrBlock: "10.0.1.0/24",
        availabilityZone: az1,
        mapPublicIpOnLaunch: true,
      }) {}

      class PrivateSubnet1 extends EC2.Subnet("PrivateSubnet1", {
        vpcId: Output.of(MyVpc).vpcId,
        cidrBlock: "10.0.10.0/24",
        availabilityZone: az1,
      }) {}

      // AZ2 subnets
      class PublicSubnet2 extends EC2.Subnet("PublicSubnet2", {
        vpcId: Output.of(MyVpc).vpcId,
        cidrBlock: "10.0.2.0/24",
        availabilityZone: az2,
        mapPublicIpOnLaunch: true,
      }) {}

      class PrivateSubnet2 extends EC2.Subnet("PrivateSubnet2", {
        vpcId: Output.of(MyVpc).vpcId,
        cidrBlock: "10.0.11.0/24",
        availabilityZone: az2,
      }) {}

      class PublicRouteTable extends EC2.RouteTable("PublicRouteTable", {
        vpcId: Output.of(MyVpc).vpcId,
      }) {}

      class PrivateRouteTable extends EC2.RouteTable("PrivateRouteTable", {
        vpcId: Output.of(MyVpc).vpcId,
      }) {}

      class InternetRoute extends EC2.Route("InternetRoute", {
        routeTableId: Output.of(PublicRouteTable).routeTableId,
        destinationCidrBlock: "0.0.0.0/0",
        gatewayId: Output.of(InternetGateway).internetGatewayId,
      }) {}

      // AZ1 associations
      class PublicSubnet1Association extends EC2.RouteTableAssociation(
        "PublicSubnet1Association",
        {
          routeTableId: Output.of(PublicRouteTable).routeTableId,
          subnetId: Output.of(PublicSubnet1).subnetId,
        },
      ) {}

      class PrivateSubnet1Association extends EC2.RouteTableAssociation(
        "PrivateSubnet1Association",
        {
          routeTableId: Output.of(PrivateRouteTable).routeTableId,
          subnetId: Output.of(PrivateSubnet1).subnetId,
        },
      ) {}

      // AZ2 associations (share route tables)
      class PublicSubnet2Association extends EC2.RouteTableAssociation(
        "PublicSubnet2Association",
        {
          routeTableId: Output.of(PublicRouteTable).routeTableId,
          subnetId: Output.of(PublicSubnet2).subnetId,
        },
      ) {}

      class PrivateSubnet2Association extends EC2.RouteTableAssociation(
        "PrivateSubnet2Association",
        {
          routeTableId: Output.of(PrivateRouteTable).routeTableId,
          subnetId: Output.of(PrivateSubnet2).subnetId,
        },
      ) {}

      const stack = yield* apply(
        MyVpc,
        InternetGateway,
        PublicSubnet1,
        PrivateSubnet1,
        PublicSubnet2,
        PrivateSubnet2,
        PublicRouteTable,
        PrivateRouteTable,
        InternetRoute,
        PublicSubnet1Association,
        PrivateSubnet1Association,
        PublicSubnet2Association,
        PrivateSubnet2Association,
      );

      // Verify subnets are in different AZs
      expect(stack.PublicSubnet1.availabilityZone).toEqual(az1);
      expect(stack.PublicSubnet2.availabilityZone).toEqual(az2);
      expect(stack.PrivateSubnet1.availabilityZone).toEqual(az1);
      expect(stack.PrivateSubnet2.availabilityZone).toEqual(az2);

      // Verify all 4 associations exist
      expect(stack.PublicSubnet1Association.associationId).toMatch(
        /^rtbassoc-/,
      );
      expect(stack.PublicSubnet2Association.associationId).toMatch(
        /^rtbassoc-/,
      );
      expect(stack.PrivateSubnet1Association.associationId).toMatch(
        /^rtbassoc-/,
      );
      expect(stack.PrivateSubnet2Association.associationId).toMatch(
        /^rtbassoc-/,
      );

      // Verify both public subnets share the same route table
      expect(stack.PublicSubnet1Association.routeTableId).toEqual(
        stack.PublicSubnet2Association.routeTableId,
      );
    }

    // =========================================================================
    // STAGE 5: Update Tags and Properties
    // User needs better organization - add tags for production
    // Tests: Tag updates on existing resources
    // =========================================================================
    yield* Effect.log("=== Stage 5: Update Tags and Properties ===");
    {
      class MyVpc extends EC2.Vpc("MyVpc", {
        cidrBlock: "10.0.0.0/16",
        enableDnsSupport: true,
        enableDnsHostnames: true,
        tags: {
          Name: "production-vpc",
          Environment: "production",
        },
      }) {}

      class InternetGateway extends EC2.InternetGateway("InternetGateway", {
        vpcId: Output.of(MyVpc).vpcId,
        tags: {
          Name: "production-igw",
        },
      }) {}

      class PublicSubnet1 extends EC2.Subnet("PublicSubnet1", {
        vpcId: Output.of(MyVpc).vpcId,
        cidrBlock: "10.0.1.0/24",
        availabilityZone: az1,
        mapPublicIpOnLaunch: true,
        tags: { Name: "public-1a", Tier: "public" },
      }) {}

      class PrivateSubnet1 extends EC2.Subnet("PrivateSubnet1", {
        vpcId: Output.of(MyVpc).vpcId,
        cidrBlock: "10.0.10.0/24",
        availabilityZone: az1,
        tags: { Name: "private-1a", Tier: "private" },
      }) {}

      class PublicSubnet2 extends EC2.Subnet("PublicSubnet2", {
        vpcId: Output.of(MyVpc).vpcId,
        cidrBlock: "10.0.2.0/24",
        availabilityZone: az2,
        mapPublicIpOnLaunch: true,
        tags: { Name: "public-1b", Tier: "public" },
      }) {}

      class PrivateSubnet2 extends EC2.Subnet("PrivateSubnet2", {
        vpcId: Output.of(MyVpc).vpcId,
        cidrBlock: "10.0.11.0/24",
        availabilityZone: az2,
        tags: { Name: "private-1b", Tier: "private" },
      }) {}

      class PublicRouteTable extends EC2.RouteTable("PublicRouteTable", {
        vpcId: Output.of(MyVpc).vpcId,
        tags: { Name: "public-rt" },
      }) {}

      class PrivateRouteTable extends EC2.RouteTable("PrivateRouteTable", {
        vpcId: Output.of(MyVpc).vpcId,
        tags: { Name: "private-rt" },
      }) {}

      class InternetRoute extends EC2.Route("InternetRoute", {
        routeTableId: Output.of(PublicRouteTable).routeTableId,
        destinationCidrBlock: "0.0.0.0/0",
        gatewayId: Output.of(InternetGateway).internetGatewayId,
      }) {}

      class PublicSubnet1Association extends EC2.RouteTableAssociation(
        "PublicSubnet1Association",
        {
          routeTableId: Output.of(PublicRouteTable).routeTableId,
          subnetId: Output.of(PublicSubnet1).subnetId,
        },
      ) {}

      class PrivateSubnet1Association extends EC2.RouteTableAssociation(
        "PrivateSubnet1Association",
        {
          routeTableId: Output.of(PrivateRouteTable).routeTableId,
          subnetId: Output.of(PrivateSubnet1).subnetId,
        },
      ) {}

      class PublicSubnet2Association extends EC2.RouteTableAssociation(
        "PublicSubnet2Association",
        {
          routeTableId: Output.of(PublicRouteTable).routeTableId,
          subnetId: Output.of(PublicSubnet2).subnetId,
        },
      ) {}

      class PrivateSubnet2Association extends EC2.RouteTableAssociation(
        "PrivateSubnet2Association",
        {
          routeTableId: Output.of(PrivateRouteTable).routeTableId,
          subnetId: Output.of(PrivateSubnet2).subnetId,
        },
      ) {}

      const stack = yield* apply(
        MyVpc,
        InternetGateway,
        PublicSubnet1,
        PrivateSubnet1,
        PublicSubnet2,
        PrivateSubnet2,
        PublicRouteTable,
        PrivateRouteTable,
        InternetRoute,
        PublicSubnet1Association,
        PrivateSubnet1Association,
        PublicSubnet2Association,
        PrivateSubnet2Association,
      );

      // Verify tags were applied by checking AWS (with retry for eventual consistency)
      yield* assertVpcTags(stack.MyVpc.vpcId, {
        Name: "production-vpc",
        Environment: "production",
      });
    }

    // =========================================================================
    // STAGE 6: Re-associate Subnet to Different Route Table
    // User wants to move PublicSubnet2 to a dedicated route table
    // Tests: Route table association update (replaceRouteTableAssociation)
    // =========================================================================
    yield* Effect.log("=== Stage 6: Re-associate Subnet ===");
    {
      class MyVpc extends EC2.Vpc("MyVpc", {
        cidrBlock: "10.0.0.0/16",
        enableDnsSupport: true,
        enableDnsHostnames: true,
        tags: {
          Name: "production-vpc",
          Environment: "production",
        },
      }) {}

      class InternetGateway extends EC2.InternetGateway("InternetGateway", {
        vpcId: Output.of(MyVpc).vpcId,
        tags: { Name: "production-igw" },
      }) {}

      class PublicSubnet1 extends EC2.Subnet("PublicSubnet1", {
        vpcId: Output.of(MyVpc).vpcId,
        cidrBlock: "10.0.1.0/24",
        availabilityZone: az1,
        mapPublicIpOnLaunch: true,
        tags: { Name: "public-1a", Tier: "public" },
      }) {}

      class PrivateSubnet1 extends EC2.Subnet("PrivateSubnet1", {
        vpcId: Output.of(MyVpc).vpcId,
        cidrBlock: "10.0.10.0/24",
        availabilityZone: az1,
        tags: { Name: "private-1a", Tier: "private" },
      }) {}

      class PublicSubnet2 extends EC2.Subnet("PublicSubnet2", {
        vpcId: Output.of(MyVpc).vpcId,
        cidrBlock: "10.0.2.0/24",
        availabilityZone: az2,
        mapPublicIpOnLaunch: true,
        tags: { Name: "public-1b", Tier: "public" },
      }) {}

      class PrivateSubnet2 extends EC2.Subnet("PrivateSubnet2", {
        vpcId: Output.of(MyVpc).vpcId,
        cidrBlock: "10.0.11.0/24",
        availabilityZone: az2,
        tags: { Name: "private-1b", Tier: "private" },
      }) {}

      class PublicRouteTable extends EC2.RouteTable("PublicRouteTable", {
        vpcId: Output.of(MyVpc).vpcId,
        tags: { Name: "public-rt" },
      }) {}

      class PrivateRouteTable extends EC2.RouteTable("PrivateRouteTable", {
        vpcId: Output.of(MyVpc).vpcId,
        tags: { Name: "private-rt" },
      }) {}

      // NEW: Dedicated route table for AZ2 public subnet
      class PublicRouteTable2 extends EC2.RouteTable("PublicRouteTable2", {
        vpcId: Output.of(MyVpc).vpcId,
        tags: { Name: "public-rt-az2" },
      }) {}

      class InternetRoute extends EC2.Route("InternetRoute", {
        routeTableId: Output.of(PublicRouteTable).routeTableId,
        destinationCidrBlock: "0.0.0.0/0",
        gatewayId: Output.of(InternetGateway).internetGatewayId,
      }) {}

      // NEW: Internet route for AZ2 public route table
      class InternetRoute2 extends EC2.Route("InternetRoute2", {
        routeTableId: Output.of(PublicRouteTable2).routeTableId,
        destinationCidrBlock: "0.0.0.0/0",
        gatewayId: Output.of(InternetGateway).internetGatewayId,
      }) {}

      class PublicSubnet1Association extends EC2.RouteTableAssociation(
        "PublicSubnet1Association",
        {
          routeTableId: Output.of(PublicRouteTable).routeTableId,
          subnetId: Output.of(PublicSubnet1).subnetId,
        },
      ) {}

      class PrivateSubnet1Association extends EC2.RouteTableAssociation(
        "PrivateSubnet1Association",
        {
          routeTableId: Output.of(PrivateRouteTable).routeTableId,
          subnetId: Output.of(PrivateSubnet1).subnetId,
        },
      ) {}

      // CHANGED: PublicSubnet2 now uses PublicRouteTable2
      class PublicSubnet2Association extends EC2.RouteTableAssociation(
        "PublicSubnet2Association",
        {
          routeTableId: Output.of(PublicRouteTable2).routeTableId,
          subnetId: Output.of(PublicSubnet2).subnetId,
        },
      ) {}

      class PrivateSubnet2Association extends EC2.RouteTableAssociation(
        "PrivateSubnet2Association",
        {
          routeTableId: Output.of(PrivateRouteTable).routeTableId,
          subnetId: Output.of(PrivateSubnet2).subnetId,
        },
      ) {}

      const stack = yield* apply(
        MyVpc,
        InternetGateway,
        PublicSubnet1,
        PrivateSubnet1,
        PublicSubnet2,
        PrivateSubnet2,
        PublicRouteTable,
        PrivateRouteTable,
        PublicRouteTable2,
        InternetRoute,
        InternetRoute2,
        PublicSubnet1Association,
        PrivateSubnet1Association,
        PublicSubnet2Association,
        PrivateSubnet2Association,
      );

      // Verify PublicSubnet2 is now associated with a different route table
      expect(stack.PublicSubnet2Association.routeTableId).toEqual(
        stack.PublicRouteTable2.routeTableId,
      );
      expect(stack.PublicSubnet2Association.routeTableId).not.toEqual(
        stack.PublicSubnet1Association.routeTableId,
      );

      // Verify the new route table has an internet route
      expect(stack.InternetRoute2.state).toEqual("active");
    }

    // =========================================================================
    // STAGE 7: Scale Down
    // User removes AZ2 resources (cost savings)
    // Tests: Resource deletion, dependency ordering during delete
    // =========================================================================
    yield* Effect.log("=== Stage 7: Scale Down ===");
    {
      class MyVpc extends EC2.Vpc("MyVpc", {
        cidrBlock: "10.0.0.0/16",
        enableDnsSupport: true,
        enableDnsHostnames: true,
        tags: {
          Name: "production-vpc",
          Environment: "production",
        },
      }) {}

      class InternetGateway extends EC2.InternetGateway("InternetGateway", {
        vpcId: Output.of(MyVpc).vpcId,
        tags: { Name: "production-igw" },
      }) {}

      // Only AZ1 subnets remain
      class PublicSubnet1 extends EC2.Subnet("PublicSubnet1", {
        vpcId: Output.of(MyVpc).vpcId,
        cidrBlock: "10.0.1.0/24",
        availabilityZone: az1,
        mapPublicIpOnLaunch: true,
        tags: { Name: "public-1a", Tier: "public" },
      }) {}

      class PrivateSubnet1 extends EC2.Subnet("PrivateSubnet1", {
        vpcId: Output.of(MyVpc).vpcId,
        cidrBlock: "10.0.10.0/24",
        availabilityZone: az1,
        tags: { Name: "private-1a", Tier: "private" },
      }) {}

      class PublicRouteTable extends EC2.RouteTable("PublicRouteTable", {
        vpcId: Output.of(MyVpc).vpcId,
        tags: { Name: "public-rt" },
      }) {}

      class PrivateRouteTable extends EC2.RouteTable("PrivateRouteTable", {
        vpcId: Output.of(MyVpc).vpcId,
        tags: { Name: "private-rt" },
      }) {}

      class InternetRoute extends EC2.Route("InternetRoute", {
        routeTableId: Output.of(PublicRouteTable).routeTableId,
        destinationCidrBlock: "0.0.0.0/0",
        gatewayId: Output.of(InternetGateway).internetGatewayId,
      }) {}

      class PublicSubnet1Association extends EC2.RouteTableAssociation(
        "PublicSubnet1Association",
        {
          routeTableId: Output.of(PublicRouteTable).routeTableId,
          subnetId: Output.of(PublicSubnet1).subnetId,
        },
      ) {}

      class PrivateSubnet1Association extends EC2.RouteTableAssociation(
        "PrivateSubnet1Association",
        {
          routeTableId: Output.of(PrivateRouteTable).routeTableId,
          subnetId: Output.of(PrivateSubnet1).subnetId,
        },
      ) {}

      // Note: PublicSubnet2, PrivateSubnet2, PublicRouteTable2, InternetRoute2,
      // and their associations are NOT included - they will be deleted

      const stack = yield* apply(
        MyVpc,
        InternetGateway,
        PublicSubnet1,
        PrivateSubnet1,
        PublicRouteTable,
        PrivateRouteTable,
        InternetRoute,
        PublicSubnet1Association,
        PrivateSubnet1Association,
      );

      // Verify only 2 subnets exist now
      const subnetsResult = yield* ec2.describeSubnets({
        Filters: [{ Name: "vpc-id", Values: [stack.MyVpc.vpcId] }],
      });
      expect(subnetsResult.Subnets).toHaveLength(2);

      // Verify remaining subnets are in AZ1
      for (const subnet of subnetsResult.Subnets ?? []) {
        expect(subnet.AvailabilityZone).toEqual(az1);
      }
    }

    // =========================================================================
    // STAGE 8: Final Cleanup
    // Destroy everything and verify
    // =========================================================================
    yield* Effect.log("=== Stage 8: Final Cleanup ===");
    const vpcId = (yield* EC2.EC2Client)
      .describeVpcs({
        Filters: [{ Name: "tag:Name", Values: ["production-vpc"] }],
      })
      .pipe(Effect.map((r) => r.Vpcs?.[0]?.VpcId));

    const capturedVpcId = yield* vpcId;

    yield* destroy();

    // Verify VPC is deleted
    if (capturedVpcId) {
      yield* ec2.describeVpcs({ VpcIds: [capturedVpcId] }).pipe(
        Effect.flatMap(() => Effect.fail(new Error("VPC still exists"))),
        Effect.catchTag("InvalidVpcID.NotFound", () => Effect.void),
      );
    }

    yield* Effect.log("=== All stages completed successfully! ===");
  }).pipe(Effect.provide(AWS.providers()), logLevel),
);

// ============================================================================
// Eventually Consistent Check Utilities
// ============================================================================

class TagsNotPropagated extends Data.TaggedError("TagsNotPropagated")<{
  readonly expected: Record<string, string>;
  readonly actual: Record<string, string | undefined>;
}> {}

/**
 * Asserts that a VPC has the expected tags, retrying until eventually consistent.
 */
const assertVpcTags = Effect.fn(function* (
  vpcId: string,
  expectedTags: Record<string, string>,
) {
  const ec2 = yield* EC2.EC2Client;

  yield* ec2.describeVpcs({ VpcIds: [vpcId] }).pipe(
    Effect.flatMap((result) => {
      const tags = result.Vpcs?.[0]?.Tags ?? [];
      const actual: Record<string, string | undefined> = {};

      for (const key of Object.keys(expectedTags)) {
        actual[key] = tags.find((t) => t.Key === key)?.Value;
      }

      const allMatch = Object.entries(expectedTags).every(
        ([key, value]) => actual[key] === value,
      );

      return allMatch
        ? Effect.succeed(result)
        : Effect.fail(
            new TagsNotPropagated({ expected: expectedTags, actual }),
          );
    }),
    Effect.tapError(Effect.log),
    Effect.retry({
      while: (e) => e._tag === "TagsNotPropagated",
      schedule: Schedule.fixed(1000).pipe(
        Schedule.intersect(Schedule.recurs(10)),
      ),
    }),
  );
});
