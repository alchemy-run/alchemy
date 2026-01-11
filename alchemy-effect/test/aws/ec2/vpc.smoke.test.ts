import * as AWS from "@/aws";
import {
  Eip,
  EgressOnlyInternetGateway,
  InternetGateway,
  NatGateway,
  NetworkAcl,
  NetworkAclAssociation,
  NetworkAclEntry,
  Route,
  RouteTable,
  RouteTableAssociation,
  SecurityGroup,
  Subnet,
  Vpc,
  VpcEndpoint,
} from "@/aws/ec2";
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
import * as EC2 from "distilled-aws/ec2";
import { Data, LogLevel, Schedule } from "effect";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as ec2 from "distilled-aws/ec2";

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

test.skipIf(!!process.env.FAST)(
  "VPC evolution: from simple to complex",
  {
    timeout: 1_000_000,
  },
  Effect.gen(function* () {
    yield* destroy();

    // Get available AZs for multi-AZ stages
    const azResult = yield* EC2.describeAvailabilityZones({});
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
      class MyVpc extends Vpc("MyVpc", {
        cidrBlock: "10.0.0.0/16",
      }) {}

      const stack = yield* apply(MyVpc);

      // Verify VPC was created
      expect(stack.MyVpc.vpcId).toMatch(/^vpc-/);
      expect(stack.MyVpc.cidrBlock).toEqual("10.0.0.0/16");
      expect(stack.MyVpc.state).toEqual("available");

      const vpcResult = yield* EC2.describeVpcs({
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
      class MyVpc extends Vpc("MyVpc", {
        cidrBlock: "10.0.0.0/16",
        enableDnsSupport: true,
        enableDnsHostnames: true,
      }) {}

      class TestInternetGateway extends InternetGateway("InternetGateway", {
        vpcId: Output.of(MyVpc).vpcId,
      }) {}

      class PublicSubnet1 extends Subnet("PublicSubnet1", {
        vpcId: Output.of(MyVpc).vpcId,
        cidrBlock: "10.0.1.0/24",
        availabilityZone: az1,
        mapPublicIpOnLaunch: true,
      }) {}

      class PublicRouteTable extends RouteTable("PublicRouteTable", {
        vpcId: Output.of(MyVpc).vpcId,
      }) {}

      class InternetRoute extends Route("InternetRoute", {
        routeTableId: Output.of(PublicRouteTable).routeTableId,
        destinationCidrBlock: "0.0.0.0/0",
        gatewayId: Output.of(TestInternetGateway).internetGatewayId,
      }) {}

      class PublicSubnet1Association extends RouteTableAssociation(
        "PublicSubnet1Association",
        {
          routeTableId: Output.of(PublicRouteTable).routeTableId,
          subnetId: Output.of(PublicSubnet1).subnetId,
        },
      ) {}

      const stack = yield* apply(
        MyVpc,
        TestInternetGateway,
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
      class MyVpc extends Vpc("MyVpc", {
        cidrBlock: "10.0.0.0/16",
        enableDnsSupport: true,
        enableDnsHostnames: true,
      }) {}

      class TestInternetGateway extends InternetGateway("InternetGateway", {
        vpcId: Output.of(MyVpc).vpcId,
      }) {}

      class PublicSubnet1 extends Subnet("PublicSubnet1", {
        vpcId: Output.of(MyVpc).vpcId,
        cidrBlock: "10.0.1.0/24",
        availabilityZone: az1,
        mapPublicIpOnLaunch: true,
      }) {}

      class PrivateSubnet1 extends Subnet("PrivateSubnet1", {
        vpcId: Output.of(MyVpc).vpcId,
        cidrBlock: "10.0.10.0/24",
        availabilityZone: az1,
      }) {}

      class PublicRouteTable extends RouteTable("PublicRouteTable", {
        vpcId: Output.of(MyVpc).vpcId,
      }) {}

      class PrivateRouteTable extends RouteTable("PrivateRouteTable", {
        vpcId: Output.of(MyVpc).vpcId,
      }) {}

      class InternetRoute extends Route("InternetRoute", {
        routeTableId: Output.of(PublicRouteTable).routeTableId,
        destinationCidrBlock: "0.0.0.0/0",
        gatewayId: Output.of(TestInternetGateway).internetGatewayId,
      }) {}

      class PublicSubnet1Association extends RouteTableAssociation(
        "PublicSubnet1Association",
        {
          routeTableId: Output.of(PublicRouteTable).routeTableId,
          subnetId: Output.of(PublicSubnet1).subnetId,
        },
      ) {}

      class PrivateSubnet1Association extends RouteTableAssociation(
        "PrivateSubnet1Association",
        {
          routeTableId: Output.of(PrivateRouteTable).routeTableId,
          subnetId: Output.of(PrivateSubnet1).subnetId,
        },
      ) {}

      const stack = yield* apply(
        MyVpc,
        TestInternetGateway,
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
      const privateRtResult = yield* EC2.describeRouteTables({
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
      class MyVpc extends Vpc("MyVpc", {
        cidrBlock: "10.0.0.0/16",
        enableDnsSupport: true,
        enableDnsHostnames: true,
      }) {}

      class TestInternetGateway extends InternetGateway("InternetGateway", {
        vpcId: Output.of(MyVpc).vpcId,
      }) {}

      // AZ1 subnets
      class PublicSubnet1 extends Subnet("PublicSubnet1", {
        vpcId: Output.of(MyVpc).vpcId,
        cidrBlock: "10.0.1.0/24",
        availabilityZone: az1,
        mapPublicIpOnLaunch: true,
      }) {}

      class PrivateSubnet1 extends Subnet("PrivateSubnet1", {
        vpcId: Output.of(MyVpc).vpcId,
        cidrBlock: "10.0.10.0/24",
        availabilityZone: az1,
      }) {}

      // AZ2 subnets
      class PublicSubnet2 extends Subnet("PublicSubnet2", {
        vpcId: Output.of(MyVpc).vpcId,
        cidrBlock: "10.0.2.0/24",
        availabilityZone: az2,
        mapPublicIpOnLaunch: true,
      }) {}

      class PrivateSubnet2 extends Subnet("PrivateSubnet2", {
        vpcId: Output.of(MyVpc).vpcId,
        cidrBlock: "10.0.11.0/24",
        availabilityZone: az2,
      }) {}

      class PublicRouteTable extends RouteTable("PublicRouteTable", {
        vpcId: Output.of(MyVpc).vpcId,
      }) {}

      class PrivateRouteTable extends RouteTable("PrivateRouteTable", {
        vpcId: Output.of(MyVpc).vpcId,
      }) {}

      class InternetRoute extends Route("InternetRoute", {
        routeTableId: Output.of(PublicRouteTable).routeTableId,
        destinationCidrBlock: "0.0.0.0/0",
        gatewayId: Output.of(TestInternetGateway).internetGatewayId,
      }) {}

      // AZ1 associations
      class PublicSubnet1Association extends RouteTableAssociation(
        "PublicSubnet1Association",
        {
          routeTableId: Output.of(PublicRouteTable).routeTableId,
          subnetId: Output.of(PublicSubnet1).subnetId,
        },
      ) {}

      class PrivateSubnet1Association extends RouteTableAssociation(
        "PrivateSubnet1Association",
        {
          routeTableId: Output.of(PrivateRouteTable).routeTableId,
          subnetId: Output.of(PrivateSubnet1).subnetId,
        },
      ) {}

      // AZ2 associations (share route tables)
      class PublicSubnet2Association extends RouteTableAssociation(
        "PublicSubnet2Association",
        {
          routeTableId: Output.of(PublicRouteTable).routeTableId,
          subnetId: Output.of(PublicSubnet2).subnetId,
        },
      ) {}

      class PrivateSubnet2Association extends RouteTableAssociation(
        "PrivateSubnet2Association",
        {
          routeTableId: Output.of(PrivateRouteTable).routeTableId,
          subnetId: Output.of(PrivateSubnet2).subnetId,
        },
      ) {}

      const stack = yield* apply(
        MyVpc,
        TestInternetGateway,
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
      class MyVpc extends Vpc("MyVpc", {
        cidrBlock: "10.0.0.0/16",
        enableDnsSupport: true,
        enableDnsHostnames: true,
        tags: {
          Name: "production-vpc",
          Environment: "production",
        },
      }) {}

      class TestInternetGateway extends InternetGateway("InternetGateway", {
        vpcId: Output.of(MyVpc).vpcId,
        tags: {
          Name: "production-igw",
        },
      }) {}

      class PublicSubnet1 extends Subnet("PublicSubnet1", {
        vpcId: Output.of(MyVpc).vpcId,
        cidrBlock: "10.0.1.0/24",
        availabilityZone: az1,
        mapPublicIpOnLaunch: true,
        tags: { Name: "public-1a", Tier: "public" },
      }) {}

      class PrivateSubnet1 extends Subnet("PrivateSubnet1", {
        vpcId: Output.of(MyVpc).vpcId,
        cidrBlock: "10.0.10.0/24",
        availabilityZone: az1,
        tags: { Name: "private-1a", Tier: "private" },
      }) {}

      class PublicSubnet2 extends Subnet("PublicSubnet2", {
        vpcId: Output.of(MyVpc).vpcId,
        cidrBlock: "10.0.2.0/24",
        availabilityZone: az2,
        mapPublicIpOnLaunch: true,
        tags: { Name: "public-1b", Tier: "public" },
      }) {}

      class PrivateSubnet2 extends Subnet("PrivateSubnet2", {
        vpcId: Output.of(MyVpc).vpcId,
        cidrBlock: "10.0.11.0/24",
        availabilityZone: az2,
        tags: { Name: "private-1b", Tier: "private" },
      }) {}

      class PublicRouteTable extends RouteTable("PublicRouteTable", {
        vpcId: Output.of(MyVpc).vpcId,
        tags: { Name: "public-rt" },
      }) {}

      class PrivateRouteTable extends RouteTable("PrivateRouteTable", {
        vpcId: Output.of(MyVpc).vpcId,
        tags: { Name: "private-rt" },
      }) {}

      class InternetRoute extends Route("InternetRoute", {
        routeTableId: Output.of(PublicRouteTable).routeTableId,
        destinationCidrBlock: "0.0.0.0/0",
        gatewayId: Output.of(TestInternetGateway).internetGatewayId,
      }) {}

      class PublicSubnet1Association extends RouteTableAssociation(
        "PublicSubnet1Association",
        {
          routeTableId: Output.of(PublicRouteTable).routeTableId,
          subnetId: Output.of(PublicSubnet1).subnetId,
        },
      ) {}

      class PrivateSubnet1Association extends RouteTableAssociation(
        "PrivateSubnet1Association",
        {
          routeTableId: Output.of(PrivateRouteTable).routeTableId,
          subnetId: Output.of(PrivateSubnet1).subnetId,
        },
      ) {}

      class PublicSubnet2Association extends RouteTableAssociation(
        "PublicSubnet2Association",
        {
          routeTableId: Output.of(PublicRouteTable).routeTableId,
          subnetId: Output.of(PublicSubnet2).subnetId,
        },
      ) {}

      class PrivateSubnet2Association extends RouteTableAssociation(
        "PrivateSubnet2Association",
        {
          routeTableId: Output.of(PrivateRouteTable).routeTableId,
          subnetId: Output.of(PrivateSubnet2).subnetId,
        },
      ) {}

      const stack = yield* apply(
        MyVpc,
        TestInternetGateway,
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
      class MyVpc extends Vpc("MyVpc", {
        cidrBlock: "10.0.0.0/16",
        enableDnsSupport: true,
        enableDnsHostnames: true,
        tags: {
          Name: "production-vpc",
          Environment: "production",
        },
      }) {}

      class TestInternetGateway extends InternetGateway("InternetGateway", {
        vpcId: Output.of(MyVpc).vpcId,
        tags: { Name: "production-igw" },
      }) {}

      class PublicSubnet1 extends Subnet("PublicSubnet1", {
        vpcId: Output.of(MyVpc).vpcId,
        cidrBlock: "10.0.1.0/24",
        availabilityZone: az1,
        mapPublicIpOnLaunch: true,
        tags: { Name: "public-1a", Tier: "public" },
      }) {}

      class PrivateSubnet1 extends Subnet("PrivateSubnet1", {
        vpcId: Output.of(MyVpc).vpcId,
        cidrBlock: "10.0.10.0/24",
        availabilityZone: az1,
        tags: { Name: "private-1a", Tier: "private" },
      }) {}

      class PublicSubnet2 extends Subnet("PublicSubnet2", {
        vpcId: Output.of(MyVpc).vpcId,
        cidrBlock: "10.0.2.0/24",
        availabilityZone: az2,
        mapPublicIpOnLaunch: true,
        tags: { Name: "public-1b", Tier: "public" },
      }) {}

      class PrivateSubnet2 extends Subnet("PrivateSubnet2", {
        vpcId: Output.of(MyVpc).vpcId,
        cidrBlock: "10.0.11.0/24",
        availabilityZone: az2,
        tags: { Name: "private-1b", Tier: "private" },
      }) {}

      class PublicRouteTable extends RouteTable("PublicRouteTable", {
        vpcId: Output.of(MyVpc).vpcId,
        tags: { Name: "public-rt" },
      }) {}

      class PrivateRouteTable extends RouteTable("PrivateRouteTable", {
        vpcId: Output.of(MyVpc).vpcId,
        tags: { Name: "private-rt" },
      }) {}

      // NEW: Dedicated route table for AZ2 public subnet
      class PublicRouteTable2 extends RouteTable("PublicRouteTable2", {
        vpcId: Output.of(MyVpc).vpcId,
        tags: { Name: "public-rt-az2" },
      }) {}

      class InternetRoute extends Route("InternetRoute", {
        routeTableId: Output.of(PublicRouteTable).routeTableId,
        destinationCidrBlock: "0.0.0.0/0",
        gatewayId: Output.of(TestInternetGateway).internetGatewayId,
      }) {}

      // NEW: Internet route for AZ2 public route table
      class InternetRoute2 extends Route("InternetRoute2", {
        routeTableId: Output.of(PublicRouteTable2).routeTableId,
        destinationCidrBlock: "0.0.0.0/0",
        gatewayId: Output.of(TestInternetGateway).internetGatewayId,
      }) {}

      class PublicSubnet1Association extends RouteTableAssociation(
        "PublicSubnet1Association",
        {
          routeTableId: Output.of(PublicRouteTable).routeTableId,
          subnetId: Output.of(PublicSubnet1).subnetId,
        },
      ) {}

      class PrivateSubnet1Association extends RouteTableAssociation(
        "PrivateSubnet1Association",
        {
          routeTableId: Output.of(PrivateRouteTable).routeTableId,
          subnetId: Output.of(PrivateSubnet1).subnetId,
        },
      ) {}

      // CHANGED: PublicSubnet2 now uses PublicRouteTable2
      class PublicSubnet2Association extends RouteTableAssociation(
        "PublicSubnet2Association",
        {
          routeTableId: Output.of(PublicRouteTable2).routeTableId,
          subnetId: Output.of(PublicSubnet2).subnetId,
        },
      ) {}

      class PrivateSubnet2Association extends RouteTableAssociation(
        "PrivateSubnet2Association",
        {
          routeTableId: Output.of(PrivateRouteTable).routeTableId,
          subnetId: Output.of(PrivateSubnet2).subnetId,
        },
      ) {}

      const stack = yield* apply(
        MyVpc,
        TestInternetGateway,
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
      class MyVpc extends Vpc("MyVpc", {
        cidrBlock: "10.0.0.0/16",
        enableDnsSupport: true,
        enableDnsHostnames: true,
        tags: {
          Name: "production-vpc",
          Environment: "production",
        },
      }) {}

      class TestInternetGateway extends InternetGateway("InternetGateway", {
        vpcId: Output.of(MyVpc).vpcId,
        tags: { Name: "production-igw" },
      }) {}

      // Only AZ1 subnets remain
      class PublicSubnet1 extends Subnet("PublicSubnet1", {
        vpcId: Output.of(MyVpc).vpcId,
        cidrBlock: "10.0.1.0/24",
        availabilityZone: az1,
        mapPublicIpOnLaunch: true,
        tags: { Name: "public-1a", Tier: "public" },
      }) {}

      class PrivateSubnet1 extends Subnet("PrivateSubnet1", {
        vpcId: Output.of(MyVpc).vpcId,
        cidrBlock: "10.0.10.0/24",
        availabilityZone: az1,
        tags: { Name: "private-1a", Tier: "private" },
      }) {}

      class PublicRouteTable extends RouteTable("PublicRouteTable", {
        vpcId: Output.of(MyVpc).vpcId,
        tags: { Name: "public-rt" },
      }) {}

      class PrivateRouteTable extends RouteTable("PrivateRouteTable", {
        vpcId: Output.of(MyVpc).vpcId,
        tags: { Name: "private-rt" },
      }) {}

      class InternetRoute extends Route("InternetRoute", {
        routeTableId: Output.of(PublicRouteTable).routeTableId,
        destinationCidrBlock: "0.0.0.0/0",
        gatewayId: Output.of(TestInternetGateway).internetGatewayId,
      }) {}

      class PublicSubnet1Association extends RouteTableAssociation(
        "PublicSubnet1Association",
        {
          routeTableId: Output.of(PublicRouteTable).routeTableId,
          subnetId: Output.of(PublicSubnet1).subnetId,
        },
      ) {}

      class PrivateSubnet1Association extends RouteTableAssociation(
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
        TestInternetGateway,
        PublicSubnet1,
        PrivateSubnet1,
        PublicRouteTable,
        PrivateRouteTable,
        InternetRoute,
        PublicSubnet1Association,
        PrivateSubnet1Association,
      );

      // Verify only 2 subnets exist now
      const subnetsResult = yield* EC2.describeSubnets({
        Filters: [{ Name: "vpc-id", Values: [stack.MyVpc.vpcId] }],
      });
      expect(subnetsResult.Subnets).toHaveLength(2);

      // Verify remaining subnets are in AZ1
      for (const subnet of subnetsResult.Subnets ?? []) {
        expect(subnet.AvailabilityZone).toEqual(az1);
      }
    }

    // =========================================================================
    // STAGE 8: Add NAT Gateway for Private Subnet Internet Access
    // User needs private instances to access internet for updates
    // Tests: EIP create, NAT Gateway create with state waiting
    // =========================================================================
    yield* Effect.log("=== Stage 8: Add NAT Gateway ===");
    {
      class MyVpc extends Vpc("MyVpc", {
        cidrBlock: "10.0.0.0/16",
        enableDnsSupport: true,
        enableDnsHostnames: true,
        tags: {
          Name: "production-vpc",
          Environment: "production",
        },
      }) {}

      class TestInternetGateway extends InternetGateway("InternetGateway", {
        vpcId: Output.of(MyVpc).vpcId,
        tags: { Name: "production-igw" },
      }) {}

      class PublicSubnet1 extends Subnet("PublicSubnet1", {
        vpcId: Output.of(MyVpc).vpcId,
        cidrBlock: "10.0.1.0/24",
        availabilityZone: az1,
        mapPublicIpOnLaunch: true,
        tags: { Name: "public-1a", Tier: "public" },
      }) {}

      class PrivateSubnet1 extends Subnet("PrivateSubnet1", {
        vpcId: Output.of(MyVpc).vpcId,
        cidrBlock: "10.0.10.0/24",
        availabilityZone: az1,
        tags: { Name: "private-1a", Tier: "private" },
      }) {}

      class PublicRouteTable extends RouteTable("PublicRouteTable", {
        vpcId: Output.of(MyVpc).vpcId,
        tags: { Name: "public-rt" },
      }) {}

      class PrivateRouteTable extends RouteTable("PrivateRouteTable", {
        vpcId: Output.of(MyVpc).vpcId,
        tags: { Name: "private-rt" },
      }) {}

      class InternetRoute extends Route("InternetRoute", {
        routeTableId: Output.of(PublicRouteTable).routeTableId,
        destinationCidrBlock: "0.0.0.0/0",
        gatewayId: Output.of(TestInternetGateway).internetGatewayId,
      }) {}

      // NEW: Elastic IP for NAT Gateway
      class NatEip extends Eip("NatEip", {
        tags: { Name: "nat-eip" },
      }) {}

      // NEW: NAT Gateway in public subnet
      class TestNatGateway extends NatGateway("NatGateway", {
        subnetId: Output.of(PublicSubnet1).subnetId,
        allocationId: Output.of(NatEip).allocationId,
        tags: { Name: "production-nat" },
      }) {}

      // NEW: Route from private subnet to NAT Gateway
      class NatRoute extends Route("NatRoute", {
        routeTableId: Output.of(PrivateRouteTable).routeTableId,
        destinationCidrBlock: "0.0.0.0/0",
        natGatewayId: Output.of(TestNatGateway).natGatewayId,
      }) {}

      class PublicSubnet1Association extends RouteTableAssociation(
        "PublicSubnet1Association",
        {
          routeTableId: Output.of(PublicRouteTable).routeTableId,
          subnetId: Output.of(PublicSubnet1).subnetId,
        },
      ) {}

      class PrivateSubnet1Association extends RouteTableAssociation(
        "PrivateSubnet1Association",
        {
          routeTableId: Output.of(PrivateRouteTable).routeTableId,
          subnetId: Output.of(PrivateSubnet1).subnetId,
        },
      ) {}

      const stack = yield* apply(
        MyVpc,
        TestInternetGateway,
        PublicSubnet1,
        PrivateSubnet1,
        PublicRouteTable,
        PrivateRouteTable,
        InternetRoute,
        NatEip,
        TestNatGateway,
        NatRoute,
        PublicSubnet1Association,
        PrivateSubnet1Association,
      );

      // Verify EIP
      expect(stack.NatEip.allocationId).toMatch(/^eipalloc-/);
      expect(stack.NatEip.publicIp).toBeDefined();

      // Verify NAT Gateway
      expect(stack.NatGateway.natGatewayId).toMatch(/^nat-/);
      expect(stack.NatGateway.state).toEqual("available");
      expect(stack.NatGateway.publicIp).toEqual(stack.NatEip.publicIp);

      // Verify NAT route is active
      expect(stack.NatRoute.state).toEqual("active");
      expect(stack.NatRoute.natGatewayId).toEqual(
        stack.NatGateway.natGatewayId,
      );

      // Verify private route table now has internet route via NAT
      const privateRtResult = yield* EC2.describeRouteTables({
        RouteTableIds: [stack.PrivateRouteTable.routeTableId],
      });
      const privateRoutes = privateRtResult.RouteTables?.[0]?.Routes ?? [];
      const privateInternetRoute = privateRoutes.find(
        (r) => r.DestinationCidrBlock === "0.0.0.0/0",
      );
      expect(privateInternetRoute?.NatGatewayId).toEqual(
        stack.NatGateway.natGatewayId,
      );
    }

    // =========================================================================
    // STAGE 9: Add Security Groups
    // User needs to control instance access
    // Tests: Security Group with inline ingress/egress rules
    // =========================================================================
    yield* Effect.log("=== Stage 9: Add Security Groups ===");
    {
      class MyVpc extends Vpc("MyVpc", {
        cidrBlock: "10.0.0.0/16",
        enableDnsSupport: true,
        enableDnsHostnames: true,
        tags: {
          Name: "production-vpc",
          Environment: "production",
        },
      }) {}

      class TestInternetGateway extends InternetGateway("InternetGateway", {
        vpcId: Output.of(MyVpc).vpcId,
        tags: { Name: "production-igw" },
      }) {}

      class PublicSubnet1 extends Subnet("PublicSubnet1", {
        vpcId: Output.of(MyVpc).vpcId,
        cidrBlock: "10.0.1.0/24",
        availabilityZone: az1,
        mapPublicIpOnLaunch: true,
        tags: { Name: "public-1a", Tier: "public" },
      }) {}

      class PrivateSubnet1 extends Subnet("PrivateSubnet1", {
        vpcId: Output.of(MyVpc).vpcId,
        cidrBlock: "10.0.10.0/24",
        availabilityZone: az1,
        tags: { Name: "private-1a", Tier: "private" },
      }) {}

      class PublicRouteTable extends RouteTable("PublicRouteTable", {
        vpcId: Output.of(MyVpc).vpcId,
        tags: { Name: "public-rt" },
      }) {}

      class PrivateRouteTable extends RouteTable("PrivateRouteTable", {
        vpcId: Output.of(MyVpc).vpcId,
        tags: { Name: "private-rt" },
      }) {}

      class InternetRoute extends Route("InternetRoute", {
        routeTableId: Output.of(PublicRouteTable).routeTableId,
        destinationCidrBlock: "0.0.0.0/0",
        gatewayId: Output.of(TestInternetGateway).internetGatewayId,
      }) {}

      class NatEip extends Eip("NatEip", {
        tags: { Name: "nat-eip" },
      }) {}

      class TestNatGateway extends NatGateway("NatGateway", {
        subnetId: Output.of(PublicSubnet1).subnetId,
        allocationId: Output.of(NatEip).allocationId,
        tags: { Name: "production-nat" },
      }) {}

      class NatRoute extends Route("NatRoute", {
        routeTableId: Output.of(PrivateRouteTable).routeTableId,
        destinationCidrBlock: "0.0.0.0/0",
        natGatewayId: Output.of(TestNatGateway).natGatewayId,
      }) {}

      // NEW: Web security group allowing HTTP/HTTPS
      class WebSecurityGroup extends SecurityGroup("WebSecurityGroup", {
        vpcId: Output.of(MyVpc).vpcId,
        description: "Web tier security group",
        ingress: [
          {
            ipProtocol: "tcp",
            fromPort: 80,
            toPort: 80,
            cidrIpv4: "0.0.0.0/0",
            description: "Allow HTTP",
          },
          {
            ipProtocol: "tcp",
            fromPort: 443,
            toPort: 443,
            cidrIpv4: "0.0.0.0/0",
            description: "Allow HTTPS",
          },
        ],
        egress: [
          {
            ipProtocol: "-1",
            cidrIpv4: "0.0.0.0/0",
            description: "Allow all outbound",
          },
        ],
        tags: { Name: "web-sg" },
      }) {}

      // NEW: Database security group allowing access from web tier
      class DbSecurityGroup extends SecurityGroup("DbSecurityGroup", {
        vpcId: Output.of(MyVpc).vpcId,
        description: "Database tier security group",
        ingress: [
          {
            ipProtocol: "tcp",
            fromPort: 5432,
            toPort: 5432,
            referencedGroupId: Output.of(WebSecurityGroup).groupId,
            description: "Allow PostgreSQL from web tier",
          },
        ],
        egress: [
          {
            ipProtocol: "-1",
            cidrIpv4: "0.0.0.0/0",
            description: "Allow all outbound",
          },
        ],
        tags: { Name: "db-sg" },
      }) {}

      class PublicSubnet1Association extends RouteTableAssociation(
        "PublicSubnet1Association",
        {
          routeTableId: Output.of(PublicRouteTable).routeTableId,
          subnetId: Output.of(PublicSubnet1).subnetId,
        },
      ) {}

      class PrivateSubnet1Association extends RouteTableAssociation(
        "PrivateSubnet1Association",
        {
          routeTableId: Output.of(PrivateRouteTable).routeTableId,
          subnetId: Output.of(PrivateSubnet1).subnetId,
        },
      ) {}

      const stack = yield* apply(
        MyVpc,
        TestInternetGateway,
        PublicSubnet1,
        PrivateSubnet1,
        PublicRouteTable,
        PrivateRouteTable,
        InternetRoute,
        NatEip,
        TestNatGateway,
        NatRoute,
        WebSecurityGroup,
        DbSecurityGroup,
        PublicSubnet1Association,
        PrivateSubnet1Association,
      );

      // Verify Web Security Group
      expect(stack.WebSecurityGroup.groupId).toMatch(/^sg-/);
      expect(stack.WebSecurityGroup.vpcId).toEqual(stack.MyVpc.vpcId);
      expect(stack.WebSecurityGroup.ingressRules).toHaveLength(2);
      expect(stack.WebSecurityGroup.egressRules).toHaveLength(1);

      // Verify DB Security Group references Web Security Group
      expect(stack.DbSecurityGroup.groupId).toMatch(/^sg-/);
      expect(stack.DbSecurityGroup.ingressRules).toHaveLength(1);
      expect(
        stack.DbSecurityGroup.ingressRules?.[0]?.referencedGroupId,
      ).toEqual(stack.WebSecurityGroup.groupId);
    }

    // =========================================================================
    // STAGE 10: Scale Down - Remove NAT Gateway and Security Groups
    // User scales down to basic VPC for cost savings
    // Tests: NAT Gateway delete with state waiting, Security Group delete
    // =========================================================================
    yield* Effect.log("=== Stage 10: Scale Down to Basic VPC ===");
    {
      class MyVpc extends Vpc("MyVpc", {
        cidrBlock: "10.0.0.0/16",
        enableDnsSupport: true,
        enableDnsHostnames: true,
        tags: {
          Name: "production-vpc",
          Environment: "production",
        },
      }) {}

      class TestInternetGateway extends InternetGateway("InternetGateway", {
        vpcId: Output.of(MyVpc).vpcId,
        tags: { Name: "production-igw" },
      }) {}

      class PublicSubnet1 extends Subnet("PublicSubnet1", {
        vpcId: Output.of(MyVpc).vpcId,
        cidrBlock: "10.0.1.0/24",
        availabilityZone: az1,
        mapPublicIpOnLaunch: true,
        tags: { Name: "public-1a", Tier: "public" },
      }) {}

      class PrivateSubnet1 extends Subnet("PrivateSubnet1", {
        vpcId: Output.of(MyVpc).vpcId,
        cidrBlock: "10.0.10.0/24",
        availabilityZone: az1,
        tags: { Name: "private-1a", Tier: "private" },
      }) {}

      class PublicRouteTable extends RouteTable("PublicRouteTable", {
        vpcId: Output.of(MyVpc).vpcId,
        tags: { Name: "public-rt" },
      }) {}

      class PrivateRouteTable extends RouteTable("PrivateRouteTable", {
        vpcId: Output.of(MyVpc).vpcId,
        tags: { Name: "private-rt" },
      }) {}

      class InternetRoute extends Route("InternetRoute", {
        routeTableId: Output.of(PublicRouteTable).routeTableId,
        destinationCidrBlock: "0.0.0.0/0",
        gatewayId: Output.of(TestInternetGateway).internetGatewayId,
      }) {}

      class PublicSubnet1Association extends RouteTableAssociation(
        "PublicSubnet1Association",
        {
          routeTableId: Output.of(PublicRouteTable).routeTableId,
          subnetId: Output.of(PublicSubnet1).subnetId,
        },
      ) {}

      class PrivateSubnet1Association extends RouteTableAssociation(
        "PrivateSubnet1Association",
        {
          routeTableId: Output.of(PrivateRouteTable).routeTableId,
          subnetId: Output.of(PrivateSubnet1).subnetId,
        },
      ) {}

      // Note: NAT Gateway, EIP, NatRoute, and Security Groups are NOT included
      // They will be deleted

      const stack = yield* apply(
        MyVpc,
        TestInternetGateway,
        PublicSubnet1,
        PrivateSubnet1,
        PublicRouteTable,
        PrivateRouteTable,
        InternetRoute,
        PublicSubnet1Association,
        PrivateSubnet1Association,
      );

      // Verify NAT Gateway is deleted
      const natGwResult = yield* ec2
        .describeNatGateways({
          Filter: [{ Name: "vpc-id", Values: [stack.MyVpc.vpcId] }],
        })
        .pipe(
          Effect.map((r) =>
            r.NatGateways?.filter((gw) => gw.State !== "deleted"),
          ),
        );
      expect(natGwResult).toHaveLength(0);

      // Verify Security Groups are deleted (only default should remain)
      const sgResult = yield* EC2.describeSecurityGroups({
        Filters: [{ Name: "vpc-id", Values: [stack.MyVpc.vpcId] }],
      });
      expect(sgResult.SecurityGroups).toHaveLength(1); // Only default SG
      expect(sgResult.SecurityGroups?.[0]?.GroupName).toEqual("default");
    }

    // =========================================================================
    // STAGE 11: Final Cleanup
    // Destroy everything and verify
    // =========================================================================
    yield* Effect.log("=== Stage 11: Final Cleanup ===");
    const vpcResult = yield* EC2.describeVpcs({
      Filters: [{ Name: "tag:Name", Values: ["production-vpc"] }],
    });
    const capturedVpcId = vpcResult.Vpcs?.[0]?.VpcId;

    yield* destroy();

    // Verify VPC is deleted
    if (capturedVpcId) {
      yield* EC2.describeVpcs({ VpcIds: [capturedVpcId] }).pipe(
        Effect.flatMap(() => Effect.fail(new Error("VPC still exists"))),
        Effect.catchTag("InvalidVpcID.NotFound", () => Effect.void),
      );
    }

    yield* Effect.log("=== All stages completed successfully! ===");
  }).pipe(Effect.provide(AWS.providers()), logLevel),
);

test.skipIf(!!process.env.FAST)(
  "Comprehensive VPC with all components",
  {
    timeout: 1_000_000,
  },
  Effect.gen(function* () {
    yield* destroy();

    // Get available AZs
    const azResult = yield* EC2.describeAvailabilityZones({});
    const availableAzs =
      azResult.AvailabilityZones?.filter((az) => az.State === "available") ??
      [];
    const az1 = availableAzs[0]?.ZoneName!;
    const az2 = availableAzs[1]?.ZoneName!;

    // =========================================================================
    // Define all resources for a production-ready VPC
    // =========================================================================

    // VPC with DNS enabled and IPv6 for egress-only IGW
    class MyVpc extends Vpc("MyVpc", {
      cidrBlock: "10.0.0.0/16",
      enableDnsSupport: true,
      enableDnsHostnames: true,
      amazonProvidedIpv6CidrBlock: true,
      tags: {
        Name: "comprehensive-vpc",
        Environment: "test",
      },
    }) {}

    // Internet Gateway for public internet access
    class TestInternetGateway extends InternetGateway("InternetGateway", {
      vpcId: Output.of(MyVpc).vpcId,
      tags: { Name: "comprehensive-igw" },
    }) {}

    // Egress-Only Internet Gateway for IPv6 outbound traffic from private subnets
    class EgressOnlyIgw extends EgressOnlyInternetGateway("EgressOnlyIgw", {
      vpcId: Output.of(MyVpc).vpcId,
      tags: { Name: "comprehensive-eigw" },
    }) {}

    // Public Subnets in two AZs
    class PublicSubnet1 extends Subnet("PublicSubnet1", {
      vpcId: Output.of(MyVpc).vpcId,
      cidrBlock: "10.0.1.0/24",
      availabilityZone: az1,
      mapPublicIpOnLaunch: true,
      tags: { Name: "public-1a", Tier: "public" },
    }) {}

    class PublicSubnet2 extends Subnet("PublicSubnet2", {
      vpcId: Output.of(MyVpc).vpcId,
      cidrBlock: "10.0.2.0/24",
      availabilityZone: az2,
      mapPublicIpOnLaunch: true,
      tags: { Name: "public-1b", Tier: "public" },
    }) {}

    // Private Subnets in two AZs
    class PrivateSubnet1 extends Subnet("PrivateSubnet1", {
      vpcId: Output.of(MyVpc).vpcId,
      cidrBlock: "10.0.10.0/24",
      availabilityZone: az1,
      tags: { Name: "private-1a", Tier: "private" },
    }) {}

    class PrivateSubnet2 extends Subnet("PrivateSubnet2", {
      vpcId: Output.of(MyVpc).vpcId,
      cidrBlock: "10.0.11.0/24",
      availabilityZone: az2,
      tags: { Name: "private-1b", Tier: "private" },
    }) {}

    // Route Tables
    class PublicRouteTable extends RouteTable("PublicRouteTable", {
      vpcId: Output.of(MyVpc).vpcId,
      tags: { Name: "public-rt" },
    }) {}

    class PrivateRouteTable1 extends RouteTable("PrivateRouteTable1", {
      vpcId: Output.of(MyVpc).vpcId,
      tags: { Name: "private-rt-1" },
    }) {}

    class PrivateRouteTable2 extends RouteTable("PrivateRouteTable2", {
      vpcId: Output.of(MyVpc).vpcId,
      tags: { Name: "private-rt-2" },
    }) {}

    // Internet route for public subnets
    class InternetRoute extends Route("InternetRoute", {
      routeTableId: Output.of(PublicRouteTable).routeTableId,
      destinationCidrBlock: "0.0.0.0/0",
      gatewayId: Output.of(TestInternetGateway).internetGatewayId,
    }) {}

    // NAT Gateway with EIP for AZ1
    class NatEip1 extends Eip("NatEip1", {
      tags: { Name: "nat-eip-1" },
    }) {}

    class TestNatGateway1 extends NatGateway("NatGateway1", {
      subnetId: Output.of(PublicSubnet1).subnetId,
      allocationId: Output.of(NatEip1).allocationId,
      tags: { Name: "nat-gateway-1" },
    }) {}

    // NAT Gateway with EIP for AZ2
    class NatEip2 extends Eip("NatEip2", {
      tags: { Name: "nat-eip-2" },
    }) {}

    class TestNatGateway2 extends NatGateway("NatGateway2", {
      subnetId: Output.of(PublicSubnet2).subnetId,
      allocationId: Output.of(NatEip2).allocationId,
      tags: { Name: "nat-gateway-2" },
    }) {}

    // NAT routes for private subnets (each AZ routes to its own NAT)
    class NatRoute1 extends Route("NatRoute1", {
      routeTableId: Output.of(PrivateRouteTable1).routeTableId,
      destinationCidrBlock: "0.0.0.0/0",
      natGatewayId: Output.of(TestNatGateway1).natGatewayId,
    }) {}

    class NatRoute2 extends Route("NatRoute2", {
      routeTableId: Output.of(PrivateRouteTable2).routeTableId,
      destinationCidrBlock: "0.0.0.0/0",
      natGatewayId: Output.of(TestNatGateway2).natGatewayId,
    }) {}

    // Route Table Associations
    class PublicSubnet1Association extends RouteTableAssociation(
      "PublicSubnet1Association",
      {
        routeTableId: Output.of(PublicRouteTable).routeTableId,
        subnetId: Output.of(PublicSubnet1).subnetId,
      },
    ) {}

    class PublicSubnet2Association extends RouteTableAssociation(
      "PublicSubnet2Association",
      {
        routeTableId: Output.of(PublicRouteTable).routeTableId,
        subnetId: Output.of(PublicSubnet2).subnetId,
      },
    ) {}

    class PrivateSubnet1Association extends RouteTableAssociation(
      "PrivateSubnet1Association",
      {
        routeTableId: Output.of(PrivateRouteTable1).routeTableId,
        subnetId: Output.of(PrivateSubnet1).subnetId,
      },
    ) {}

    class PrivateSubnet2Association extends RouteTableAssociation(
      "PrivateSubnet2Association",
      {
        routeTableId: Output.of(PrivateRouteTable2).routeTableId,
        subnetId: Output.of(PrivateSubnet2).subnetId,
      },
    ) {}

    // Security Groups
    class WebSecurityGroup extends SecurityGroup("WebSecurityGroup", {
      vpcId: Output.of(MyVpc).vpcId,
      description: "Web tier security group",
      ingress: [
        {
          ipProtocol: "tcp",
          fromPort: 80,
          toPort: 80,
          cidrIpv4: "0.0.0.0/0",
          description: "Allow HTTP",
        },
        {
          ipProtocol: "tcp",
          fromPort: 443,
          toPort: 443,
          cidrIpv4: "0.0.0.0/0",
          description: "Allow HTTPS",
        },
      ],
      egress: [
        {
          ipProtocol: "-1",
          cidrIpv4: "0.0.0.0/0",
          description: "Allow all outbound",
        },
      ],
      tags: { Name: "web-sg" },
    }) {}

    class AppSecurityGroup extends SecurityGroup("AppSecurityGroup", {
      vpcId: Output.of(MyVpc).vpcId,
      description: "Application tier security group",
      ingress: [
        {
          ipProtocol: "tcp",
          fromPort: 8080,
          toPort: 8080,
          referencedGroupId: Output.of(WebSecurityGroup).groupId,
          description: "Allow from web tier",
        },
      ],
      egress: [
        {
          ipProtocol: "-1",
          cidrIpv4: "0.0.0.0/0",
          description: "Allow all outbound",
        },
      ],
      tags: { Name: "app-sg" },
    }) {}

    class DbSecurityGroup extends SecurityGroup("DbSecurityGroup", {
      vpcId: Output.of(MyVpc).vpcId,
      description: "Database tier security group",
      ingress: [
        {
          ipProtocol: "tcp",
          fromPort: 5432,
          toPort: 5432,
          referencedGroupId: Output.of(AppSecurityGroup).groupId,
          description: "Allow PostgreSQL from app tier",
        },
      ],
      egress: [
        {
          ipProtocol: "-1",
          cidrIpv4: "0.0.0.0/0",
          description: "Allow all outbound",
        },
      ],
      tags: { Name: "db-sg" },
    }) {}

    // Network ACL for private subnets with custom rules
    class PrivateNetworkAcl extends NetworkAcl("PrivateNetworkAcl", {
      vpcId: Output.of(MyVpc).vpcId,
      tags: { Name: "private-nacl" },
    }) {}

    // Network ACL Entries (rules)
    // Allow inbound traffic from VPC CIDR
    class PrivateNaclIngressVpc extends NetworkAclEntry(
      "PrivateNaclIngressVpc",
      {
        networkAclId: Output.of(PrivateNetworkAcl).networkAclId,
        ruleNumber: 100,
        protocol: "-1", // All protocols
        ruleAction: "allow",
        egress: false,
        cidrBlock: "10.0.0.0/16",
      },
    ) {}

    // Allow inbound ephemeral ports (for NAT return traffic)
    class PrivateNaclIngressEphemeral extends NetworkAclEntry(
      "PrivateNaclIngressEphemeral",
      {
        networkAclId: Output.of(PrivateNetworkAcl).networkAclId,
        ruleNumber: 200,
        protocol: "6", // TCP
        ruleAction: "allow",
        egress: false,
        cidrBlock: "0.0.0.0/0",
        portRange: { from: 1024, to: 65535 },
      },
    ) {}

    // Allow all outbound traffic
    class PrivateNaclEgressAll extends NetworkAclEntry("PrivateNaclEgressAll", {
      networkAclId: Output.of(PrivateNetworkAcl).networkAclId,
      ruleNumber: 100,
      protocol: "-1", // All protocols
      ruleAction: "allow",
      egress: true,
      cidrBlock: "0.0.0.0/0",
    }) {}

    // Network ACL Associations - associate private subnets with the custom NACL
    class PrivateSubnet1NaclAssoc extends NetworkAclAssociation(
      "PrivateSubnet1NaclAssoc",
      {
        networkAclId: Output.of(PrivateNetworkAcl).networkAclId,
        subnetId: Output.of(PrivateSubnet1).subnetId,
      },
    ) {}

    class PrivateSubnet2NaclAssoc extends NetworkAclAssociation(
      "PrivateSubnet2NaclAssoc",
      {
        networkAclId: Output.of(PrivateNetworkAcl).networkAclId,
        subnetId: Output.of(PrivateSubnet2).subnetId,
      },
    ) {}

    // VPC Gateway Endpoint for S3 (reduces NAT costs and improves latency)
    class S3Endpoint extends VpcEndpoint("S3Endpoint", {
      vpcId: Output.of(MyVpc).vpcId,
      serviceName: `com.amazonaws.${
        (yield* EC2.describeAvailabilityZones({})).AvailabilityZones?.[0]
          ?.RegionName
      }.s3`,
      vpcEndpointType: "Gateway",
      routeTableIds: [
        Output.of(PrivateRouteTable1).routeTableId,
        Output.of(PrivateRouteTable2).routeTableId,
      ],
      tags: { Name: "s3-endpoint" },
    }) {}

    // =========================================================================
    // Apply all resources at once
    // =========================================================================
    const stack = yield* apply(
      MyVpc,
      TestInternetGateway,
      EgressOnlyIgw,
      PublicSubnet1,
      PublicSubnet2,
      PrivateSubnet1,
      PrivateSubnet2,
      PublicRouteTable,
      PrivateRouteTable1,
      PrivateRouteTable2,
      InternetRoute,
      NatEip1,
      NatEip2,
      TestNatGateway1,
      TestNatGateway2,
      NatRoute1,
      NatRoute2,
      PublicSubnet1Association,
      PublicSubnet2Association,
      PrivateSubnet1Association,
      PrivateSubnet2Association,
      WebSecurityGroup,
      AppSecurityGroup,
      DbSecurityGroup,
      PrivateNetworkAcl,
      PrivateNaclIngressVpc,
      PrivateNaclIngressEphemeral,
      PrivateNaclEgressAll,
      PrivateSubnet1NaclAssoc,
      PrivateSubnet2NaclAssoc,
      S3Endpoint,
    );

    // =========================================================================
    // Verify VPC
    // =========================================================================
    expect(stack.MyVpc.vpcId).toMatch(/^vpc-/);
    expect(stack.MyVpc.cidrBlock).toEqual("10.0.0.0/16");
    expect(stack.MyVpc.state).toEqual("available");

    const vpcResult = yield* EC2.describeVpcs({
      VpcIds: [stack.MyVpc.vpcId],
    });
    expect(vpcResult.Vpcs?.[0]?.CidrBlock).toEqual("10.0.0.0/16");
    // EnableDnsSupport and EnableDnsHostnames are not present in the describeVpcs output.
    // Instead, use describeVpcAttribute for these:
    const dnsSupport = yield* EC2.describeVpcAttribute({
      VpcId: stack.MyVpc.vpcId,
      Attribute: "enableDnsSupport",
    });
    expect(dnsSupport.EnableDnsSupport?.Value).toBeTruthy();

    const dnsHostnames = yield* EC2.describeVpcAttribute({
      VpcId: stack.MyVpc.vpcId,
      Attribute: "enableDnsHostnames",
    });
    expect(dnsHostnames.EnableDnsHostnames?.Value).toBeTruthy();

    // Verify VPC has IPv6 CIDR block
    expect(stack.MyVpc.ipv6CidrBlockAssociationSet).toBeDefined();
    expect(stack.MyVpc.ipv6CidrBlockAssociationSet?.length).toBeGreaterThan(0);

    // =========================================================================
    // Verify Internet Gateway
    // =========================================================================
    expect(stack.InternetGateway.internetGatewayId).toMatch(/^igw-/);
    expect(stack.InternetGateway.vpcId).toEqual(stack.MyVpc.vpcId);

    // =========================================================================
    // Verify Egress-Only Internet Gateway
    // =========================================================================
    expect(stack.EgressOnlyIgw.egressOnlyInternetGatewayId).toMatch(/^eigw-/);
    expect(stack.EgressOnlyIgw.attachments).toBeDefined();
    expect(stack.EgressOnlyIgw.attachments?.[0]?.vpcId).toEqual(
      stack.MyVpc.vpcId,
    );

    // =========================================================================
    // Verify Subnets
    // =========================================================================
    expect(stack.PublicSubnet1.subnetId).toMatch(/^subnet-/);
    expect(stack.PublicSubnet1.availabilityZone).toEqual(az1);
    expect(stack.PublicSubnet1.mapPublicIpOnLaunch).toEqual(true);

    expect(stack.PublicSubnet2.subnetId).toMatch(/^subnet-/);
    expect(stack.PublicSubnet2.availabilityZone).toEqual(az2);
    expect(stack.PublicSubnet2.mapPublicIpOnLaunch).toEqual(true);

    expect(stack.PrivateSubnet1.subnetId).toMatch(/^subnet-/);
    expect(stack.PrivateSubnet1.availabilityZone).toEqual(az1);
    expect(stack.PrivateSubnet1.mapPublicIpOnLaunch).toBeFalsy();

    expect(stack.PrivateSubnet2.subnetId).toMatch(/^subnet-/);
    expect(stack.PrivateSubnet2.availabilityZone).toEqual(az2);
    expect(stack.PrivateSubnet2.mapPublicIpOnLaunch).toBeFalsy();

    // Verify 4 subnets total
    const subnetsResult = yield* EC2.describeSubnets({
      Filters: [{ Name: "vpc-id", Values: [stack.MyVpc.vpcId] }],
    });
    expect(subnetsResult.Subnets).toHaveLength(4);

    // =========================================================================
    // Verify NAT Gateways and EIPs
    // =========================================================================
    expect(stack.NatEip1.allocationId).toMatch(/^eipalloc-/);
    expect(stack.NatEip1.publicIp).toBeDefined();

    expect(stack.NatEip2.allocationId).toMatch(/^eipalloc-/);
    expect(stack.NatEip2.publicIp).toBeDefined();

    expect(stack.NatGateway1.natGatewayId).toMatch(/^nat-/);
    expect(stack.NatGateway1.state).toEqual("available");
    expect(stack.NatGateway1.publicIp).toEqual(stack.NatEip1.publicIp);
    expect(stack.NatGateway1.subnetId).toEqual(stack.PublicSubnet1.subnetId);

    expect(stack.NatGateway2.natGatewayId).toMatch(/^nat-/);
    expect(stack.NatGateway2.state).toEqual("available");
    expect(stack.NatGateway2.publicIp).toEqual(stack.NatEip2.publicIp);
    expect(stack.NatGateway2.subnetId).toEqual(stack.PublicSubnet2.subnetId);

    // =========================================================================
    // Verify Routes
    // =========================================================================
    // Internet route to IGW
    expect(stack.InternetRoute.state).toEqual("active");
    expect(stack.InternetRoute.gatewayId).toEqual(
      stack.InternetGateway.internetGatewayId,
    );

    // NAT routes
    expect(stack.NatRoute1.state).toEqual("active");
    expect(stack.NatRoute1.natGatewayId).toEqual(
      stack.NatGateway1.natGatewayId,
    );

    expect(stack.NatRoute2.state).toEqual("active");
    expect(stack.NatRoute2.natGatewayId).toEqual(
      stack.NatGateway2.natGatewayId,
    );

    // Verify public route table has internet route
    const publicRtResult = yield* EC2.describeRouteTables({
      RouteTableIds: [stack.PublicRouteTable.routeTableId],
    });
    const publicRoutes = publicRtResult.RouteTables?.[0]?.Routes ?? [];
    const publicInternetRoute = publicRoutes.find(
      (r) => r.DestinationCidrBlock === "0.0.0.0/0",
    );
    expect(publicInternetRoute?.GatewayId).toEqual(
      stack.InternetGateway.internetGatewayId,
    );

    // Verify private route tables have NAT routes
    const private1RtResult = yield* EC2.describeRouteTables({
      RouteTableIds: [stack.PrivateRouteTable1.routeTableId],
    });
    const private1Routes = private1RtResult.RouteTables?.[0]?.Routes ?? [];
    const private1NatRoute = private1Routes.find(
      (r) => r.DestinationCidrBlock === "0.0.0.0/0",
    );
    expect(private1NatRoute?.NatGatewayId).toEqual(
      stack.NatGateway1.natGatewayId,
    );

    const private2RtResult = yield* EC2.describeRouteTables({
      RouteTableIds: [stack.PrivateRouteTable2.routeTableId],
    });
    const private2Routes = private2RtResult.RouteTables?.[0]?.Routes ?? [];
    const private2NatRoute = private2Routes.find(
      (r) => r.DestinationCidrBlock === "0.0.0.0/0",
    );
    expect(private2NatRoute?.NatGatewayId).toEqual(
      stack.NatGateway2.natGatewayId,
    );

    // =========================================================================
    // Verify Route Table Associations
    // =========================================================================
    expect(stack.PublicSubnet1Association.associationId).toMatch(/^rtbassoc-/);
    expect(stack.PublicSubnet2Association.associationId).toMatch(/^rtbassoc-/);
    expect(stack.PrivateSubnet1Association.associationId).toMatch(/^rtbassoc-/);
    expect(stack.PrivateSubnet2Association.associationId).toMatch(/^rtbassoc-/);

    // Both public subnets share the same route table
    expect(stack.PublicSubnet1Association.routeTableId).toEqual(
      stack.PublicSubnet2Association.routeTableId,
    );

    // Private subnets have their own route tables (for HA NAT)
    expect(stack.PrivateSubnet1Association.routeTableId).not.toEqual(
      stack.PrivateSubnet2Association.routeTableId,
    );

    // =========================================================================
    // Verify Security Groups
    // =========================================================================
    expect(stack.WebSecurityGroup.groupId).toMatch(/^sg-/);
    expect(stack.WebSecurityGroup.vpcId).toEqual(stack.MyVpc.vpcId);
    expect(stack.WebSecurityGroup.ingressRules).toHaveLength(2);
    // TODO(sam): why is it 2 when we only have 1? is it a default or egress only ingress?
    expect(stack.WebSecurityGroup.egressRules).toHaveLength(2);

    expect(stack.AppSecurityGroup.groupId).toMatch(/^sg-/);
    expect(stack.AppSecurityGroup.vpcId).toEqual(stack.MyVpc.vpcId);
    expect(stack.AppSecurityGroup.ingressRules).toHaveLength(1);
    expect(stack.AppSecurityGroup.ingressRules?.[0]?.referencedGroupId).toEqual(
      stack.WebSecurityGroup.groupId,
    );

    expect(stack.DbSecurityGroup.groupId).toMatch(/^sg-/);
    expect(stack.DbSecurityGroup.vpcId).toEqual(stack.MyVpc.vpcId);
    expect(stack.DbSecurityGroup.ingressRules).toHaveLength(1);
    expect(stack.DbSecurityGroup.ingressRules?.[0]?.referencedGroupId).toEqual(
      stack.AppSecurityGroup.groupId,
    );

    // Verify security groups in AWS
    const sgResult = yield* EC2.describeSecurityGroups({
      Filters: [{ Name: "vpc-id", Values: [stack.MyVpc.vpcId] }],
    });
    // 4 security groups: default + web + app + db
    expect(sgResult.SecurityGroups).toHaveLength(4);

    // =========================================================================
    // Verify Network ACL
    // =========================================================================
    expect(stack.PrivateNetworkAcl.networkAclId).toMatch(/^acl-/);
    expect(stack.PrivateNetworkAcl.vpcId).toEqual(stack.MyVpc.vpcId);
    expect(stack.PrivateNetworkAcl.isDefault).toEqual(false);

    // Verify Network ACL in AWS
    const naclResult = yield* EC2.describeNetworkAcls({
      NetworkAclIds: [stack.PrivateNetworkAcl.networkAclId],
    });
    expect(naclResult.NetworkAcls).toHaveLength(1);
    expect(naclResult.NetworkAcls?.[0]?.VpcId).toEqual(stack.MyVpc.vpcId);

    // =========================================================================
    // Verify Network ACL Entries
    // =========================================================================
    expect(stack.PrivateNaclIngressVpc.networkAclId).toEqual(
      stack.PrivateNetworkAcl.networkAclId,
    );
    expect(stack.PrivateNaclIngressVpc.ruleNumber).toEqual(100);
    expect(stack.PrivateNaclIngressVpc.egress).toEqual(false);
    expect(stack.PrivateNaclIngressVpc.ruleAction).toEqual("allow");

    expect(stack.PrivateNaclIngressEphemeral.ruleNumber).toEqual(200);
    expect(stack.PrivateNaclIngressEphemeral.portRange).toEqual({
      from: 1024,
      to: 65535,
    });

    expect(stack.PrivateNaclEgressAll.egress).toEqual(true);
    expect(stack.PrivateNaclEgressAll.ruleNumber).toEqual(100);

    // =========================================================================
    // Verify Network ACL Associations
    // =========================================================================
    expect(stack.PrivateSubnet1NaclAssoc.associationId).toMatch(/^aclassoc-/);
    expect(stack.PrivateSubnet1NaclAssoc.networkAclId).toEqual(
      stack.PrivateNetworkAcl.networkAclId,
    );
    expect(stack.PrivateSubnet1NaclAssoc.subnetId).toEqual(
      stack.PrivateSubnet1.subnetId,
    );

    expect(stack.PrivateSubnet2NaclAssoc.associationId).toMatch(/^aclassoc-/);
    expect(stack.PrivateSubnet2NaclAssoc.subnetId).toEqual(
      stack.PrivateSubnet2.subnetId,
    );

    // =========================================================================
    // Verify VPC Endpoint for S3
    // =========================================================================
    expect(stack.S3Endpoint.vpcEndpointId).toMatch(/^vpce-/);
    expect(stack.S3Endpoint.vpcEndpointType).toEqual("Gateway");
    expect(stack.S3Endpoint.vpcId).toEqual(stack.MyVpc.vpcId);
    expect(stack.S3Endpoint.state).toEqual("available");
    expect(stack.S3Endpoint.routeTableIds).toContain(
      stack.PrivateRouteTable1.routeTableId,
    );
    expect(stack.S3Endpoint.routeTableIds).toContain(
      stack.PrivateRouteTable2.routeTableId,
    );

    // Verify VPC Endpoint in AWS
    const vpceResult = yield* EC2.describeVpcEndpoints({
      VpcEndpointIds: [stack.S3Endpoint.vpcEndpointId],
    });
    expect(vpceResult.VpcEndpoints).toHaveLength(1);
    expect(vpceResult.VpcEndpoints?.[0]?.VpcEndpointType).toEqual("Gateway");

    // =========================================================================
    // Verify Tags
    // =========================================================================
    yield* assertVpcTags(stack.MyVpc.vpcId, {
      Name: "comprehensive-vpc",
      Environment: "test",
    });

    // =========================================================================
    // Idempotency check - apply again and verify no changes
    // =========================================================================
    yield* Effect.log("=== Idempotency Check: Re-applying stack ===");
    const stack2 = yield* apply(
      MyVpc,
      TestInternetGateway,
      EgressOnlyIgw,
      PublicSubnet1,
      PublicSubnet2,
      PrivateSubnet1,
      PrivateSubnet2,
      PublicRouteTable,
      PrivateRouteTable1,
      PrivateRouteTable2,
      InternetRoute,
      NatEip1,
      NatEip2,
      TestNatGateway1,
      TestNatGateway2,
      NatRoute1,
      NatRoute2,
      PublicSubnet1Association,
      PublicSubnet2Association,
      PrivateSubnet1Association,
      PrivateSubnet2Association,
      WebSecurityGroup,
      AppSecurityGroup,
      DbSecurityGroup,
      PrivateNetworkAcl,
      PrivateNaclIngressVpc,
      PrivateNaclIngressEphemeral,
      PrivateNaclEgressAll,
      PrivateSubnet1NaclAssoc,
      PrivateSubnet2NaclAssoc,
      S3Endpoint,
    );

    // All IDs should remain the same
    expect(stack2.MyVpc.vpcId).toEqual(stack.MyVpc.vpcId);
    expect(stack2.InternetGateway.internetGatewayId).toEqual(
      stack.InternetGateway.internetGatewayId,
    );
    expect(stack2.EgressOnlyIgw.egressOnlyInternetGatewayId).toEqual(
      stack.EgressOnlyIgw.egressOnlyInternetGatewayId,
    );
    expect(stack2.NatGateway1.natGatewayId).toEqual(
      stack.NatGateway1.natGatewayId,
    );
    expect(stack2.NatGateway2.natGatewayId).toEqual(
      stack.NatGateway2.natGatewayId,
    );
    expect(stack2.PrivateNetworkAcl.networkAclId).toEqual(
      stack.PrivateNetworkAcl.networkAclId,
    );
    expect(stack2.S3Endpoint.vpcEndpointId).toEqual(
      stack.S3Endpoint.vpcEndpointId,
    );

    // =========================================================================
    // Cleanup
    // =========================================================================
    yield* Effect.log("=== Cleanup: Destroying all resources ===");
    const capturedVpcId = stack.MyVpc.vpcId;

    yield* destroy();

    // Verify VPC is deleted
    yield* EC2.describeVpcs({ VpcIds: [capturedVpcId] }).pipe(
      Effect.flatMap(() => Effect.fail(new Error("VPC still exists"))),
      Effect.catchTag("InvalidVpcID.NotFound", () => Effect.void),
    );

    yield* Effect.log("=== Comprehensive VPC test completed successfully! ===");
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
  yield* EC2.describeVpcs({ VpcIds: [vpcId] }).pipe(
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
