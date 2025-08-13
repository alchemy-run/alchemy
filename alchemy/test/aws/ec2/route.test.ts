import { DescribeRouteTablesCommand, EC2Client } from "@aws-sdk/client-ec2";
import { describe, expect } from "vitest";
import { alchemy } from "../../../src/alchemy.ts";
import { InternetGatewayAttachment } from "../../../src/aws/ec2/internet-gateway-attachment.ts";
import { InternetGateway } from "../../../src/aws/ec2/internet-gateway.ts";
import { RouteTable } from "../../../src/aws/ec2/route-table.ts";
import { Route } from "../../../src/aws/ec2/route.ts";
import { Vpc } from "../../../src/aws/ec2/vpc.ts";
import { destroy } from "../../../src/destroy.ts";
import "../../../src/test/vitest.ts";
import { BRANCH_PREFIX } from "../../util.ts";

// Set test environment variables for AWS tests
process.env.AWS_PROFILE = process.env.AWS_PROFILE || "default";
process.env.AWS_REGION = process.env.AWS_REGION || "us-west-2";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

const ec2 = new EC2Client({});

describe.skipIf(!process.env.ALL_TESTS)("Route", () => {
  test("create route to internet gateway", async (scope) => {
    const vpcName = `${BRANCH_PREFIX}-alchemy-test-route-vpc`;
    const rtName = `${BRANCH_PREFIX}-alchemy-test-route-rt`;
    const igwName = `${BRANCH_PREFIX}-alchemy-test-route-igw`;
    let vpc: Awaited<ReturnType<typeof Vpc>>;
    let routeTable: Awaited<ReturnType<typeof RouteTable>>;
    let internetGateway: Awaited<ReturnType<typeof InternetGateway>>;
    let _igwAttachment: Awaited<ReturnType<typeof InternetGatewayAttachment>>;
    let route: Awaited<ReturnType<typeof Route>>;
    try {
      // Create VPC, route table, and internet gateway
      vpc = await Vpc(vpcName, {
        cidrBlock: "10.0.0.0/16",
        tags: { Name: vpcName },
      });

      routeTable = await RouteTable(rtName, {
        vpc,
        tags: { Name: rtName },
      });

      internetGateway = await InternetGateway(igwName, {
        tags: { Name: igwName },
      });

      // Attach the Internet Gateway to the VPC
      _igwAttachment = await InternetGatewayAttachment(
        `${igwName}-attachment`,
        {
          internetGateway,
          vpc,
        },
      );

      route = await Route(`${BRANCH_PREFIX}-alchemy-test-route`, {
        routeTable,
        destinationCidrBlock: "0.0.0.0/0",
        target: { internetGateway: internetGateway },
      });

      expect(route.routeTableId).toBe(routeTable.routeTableId);
      expect(route.destinationCidrBlock).toBe("0.0.0.0/0");
      expect(route.target).toEqual({ internetGateway: internetGateway });

      // Verify route exists in route table
      const describeResponse = await ec2.send(
        new DescribeRouteTablesCommand({
          RouteTableIds: [routeTable.routeTableId],
        }),
      );
      const rt = describeResponse.RouteTables?.[0];
      const routeExists = rt?.Routes?.some(
        (r) =>
          r.DestinationCidrBlock === "0.0.0.0/0" &&
          r.GatewayId === internetGateway.internetGatewayId,
      );
      expect(routeExists).toBe(true);
    } finally {
      // Always clean up, even if test fails
      await destroy(scope);
    }
  });

  test("create route with credential overrides", async (scope) => {
    const vpcName = `${BRANCH_PREFIX}-alchemy-test-route-creds-vpc`;
    const rtName = `${BRANCH_PREFIX}-alchemy-test-route-creds-rt`;
    const igwName = `${BRANCH_PREFIX}-alchemy-test-route-creds-igw`;
    let vpc: Awaited<ReturnType<typeof Vpc>>;
    let routeTable: Awaited<ReturnType<typeof RouteTable>>;
    let internetGateway: Awaited<ReturnType<typeof InternetGateway>>;
    let _igwAttachment: Awaited<ReturnType<typeof InternetGatewayAttachment>>;
    let route: Awaited<ReturnType<typeof Route>>;

    try {
      // Create VPC, route table, and internet gateway with region override
      vpc = await Vpc(vpcName, {
        cidrBlock: "10.0.0.0/16",
        region: "us-west-2", // Override region
        tags: { Name: vpcName },
      });

      routeTable = await RouteTable(rtName, {
        vpc,
        region: "us-west-2", // Override region
        tags: { Name: rtName },
      });

      internetGateway = await InternetGateway(igwName, {
        region: "us-west-2", // Override region
        tags: { Name: igwName },
      });

      // Attach the Internet Gateway to the VPC
      _igwAttachment = await InternetGatewayAttachment(
        `${igwName}-attachment`,
        {
          internetGateway,
          vpc,
          region: "us-west-2", // Override region
        },
      );

      // Create Route with explicit region override
      route = await Route(`${BRANCH_PREFIX}-alchemy-test-route-creds`, {
        routeTable,
        destinationCidrBlock: "0.0.0.0/0",
        target: { internetGateway: internetGateway },
        region: "us-west-2", // Override region
      });

      expect(route.routeTableId).toBe(routeTable.routeTableId);
      expect(route.destinationCidrBlock).toBe("0.0.0.0/0");

      // Verify route exists in the specified region
      const regionalEc2 = new EC2Client({ region: "us-west-2" });
      const describeResponse = await regionalEc2.send(
        new DescribeRouteTablesCommand({
          RouteTableIds: [routeTable.routeTableId],
        }),
      );
      const rt = describeResponse.RouteTables?.[0];
      const routeExists = rt?.Routes?.some(
        (r) =>
          r.DestinationCidrBlock === "0.0.0.0/0" &&
          r.GatewayId === internetGateway.internetGatewayId,
      );
      expect(routeExists).toBe(true);
    } finally {
      // Always clean up, even if test fails
      await destroy(scope);
    }
  });

  test("create route with profile override", async (scope) => {
    const vpcName = `${BRANCH_PREFIX}-alchemy-test-route-profile-vpc`;
    const rtName = `${BRANCH_PREFIX}-alchemy-test-route-profile-rt`;
    const igwName = `${BRANCH_PREFIX}-alchemy-test-route-profile-igw`;
    let vpc: Awaited<ReturnType<typeof Vpc>>;
    let routeTable: Awaited<ReturnType<typeof RouteTable>>;
    let internetGateway: Awaited<ReturnType<typeof InternetGateway>>;
    let _igwAttachment: Awaited<ReturnType<typeof InternetGatewayAttachment>>;
    let route: Awaited<ReturnType<typeof Route>>;

    try {
      // Create VPC, route table, and internet gateway with profile override
      vpc = await Vpc(vpcName, {
        cidrBlock: "10.0.0.0/16",
        profile: process.env.AWS_PROFILE || "default", // Override profile
        region: "us-west-2",
        tags: { Name: vpcName },
      });

      routeTable = await RouteTable(rtName, {
        vpc,
        profile: process.env.AWS_PROFILE || "default", // Override profile
        region: "us-west-2",
        tags: { Name: rtName },
      });

      internetGateway = await InternetGateway(igwName, {
        profile: process.env.AWS_PROFILE || "default", // Override profile
        region: "us-west-2",
        tags: { Name: igwName },
      });

      // Attach the Internet Gateway to the VPC
      _igwAttachment = await InternetGatewayAttachment(
        `${igwName}-attachment`,
        {
          internetGateway,
          vpc,
          profile: process.env.AWS_PROFILE || "default", // Override profile
          region: "us-west-2",
        },
      );

      // Create Route with profile override
      route = await Route(`${BRANCH_PREFIX}-alchemy-test-route-profile`, {
        routeTable,
        destinationCidrBlock: "0.0.0.0/0",
        target: { internetGateway: internetGateway },
        profile: process.env.AWS_PROFILE || "default", // Override profile
        region: "us-west-2",
      });

      expect(route.routeTableId).toBe(routeTable.routeTableId);
      expect(route.destinationCidrBlock).toBe("0.0.0.0/0");

      // Verify route exists
      const describeResponse = await ec2.send(
        new DescribeRouteTablesCommand({
          RouteTableIds: [routeTable.routeTableId],
        }),
      );
      const rt = describeResponse.RouteTables?.[0];
      const routeExists = rt?.Routes?.some(
        (r) =>
          r.DestinationCidrBlock === "0.0.0.0/0" &&
          r.GatewayId === internetGateway.internetGatewayId,
      );
      expect(routeExists).toBe(true);
    } finally {
      // Always clean up, even if test fails
      await destroy(scope);
    }
  });
});
