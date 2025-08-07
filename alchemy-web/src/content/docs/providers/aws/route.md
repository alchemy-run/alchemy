---
title: Route
description: Create and manage individual routes within AWS Route Tables to direct network traffic.
---

An [AWS Route](https://docs.aws.amazon.com/vpc/latest/userguide/VPC_Route_Tables.html#route-table-routes) defines how network traffic is directed within a VPC. Routes specify a destination CIDR block and a target where matching traffic should be sent.

:::note
See AWS's official [Route Tables documentation](https://docs.aws.amazon.com/vpc/latest/userguide/VPC_Route_Tables.html) for more information.
:::

## Minimal Example

Create a basic internet route via an Internet Gateway:

```ts
import { 
  Vpc, 
  RouteTable, 
  InternetGateway, 
  Route 
} from "alchemy/aws/ec2";

const vpc = await Vpc("main-vpc", {
  cidrBlock: "10.0.0.0/16"
});

const routeTable = await RouteTable("public-rt", {
  vpc
});

const igw = await InternetGateway("main-igw", {});

const defaultRoute = await Route("internet-route", {
  routeTable,
  destinationCidrBlock: "0.0.0.0/0",
  target: { internetGateway: igw }
});
```

## Internet Gateway Route

Create a default route to an Internet Gateway for internet access:

```ts
import { 
  Vpc,
  RouteTable,
  InternetGateway,
  InternetGatewayAttachment,
  Route
} from "alchemy/aws/ec2";

const vpc = await Vpc("web-vpc", {
  cidrBlock: "10.0.0.0/16"
});

const publicRouteTable = await RouteTable("public-rt", {
  vpc,
  tags: {
    Name: "public-route-table"
  }
});

const igw = await InternetGateway("web-igw", {});

const igwAttachment = await InternetGatewayAttachment("web-igw-attachment", {
  internetGateway: igw,
  vpc: vpc
});

const internetRoute = await Route("public-internet-route", {
  routeTable: publicRouteTable,
  destinationCidrBlock: "0.0.0.0/0",
  target: { internetGateway: igw }
});
```

## NAT Gateway Route

Create a default route via NAT Gateway for private subnet internet access:

```ts
import { 
  Vpc,
  Subnet,
  RouteTable,
  NatGateway,
  Route
} from "alchemy/aws/ec2";

const vpc = await Vpc("app-vpc", {
  cidrBlock: "10.0.0.0/16"
});

const publicSubnet = await Subnet("public-subnet", {
  vpc,
  cidrBlock: "10.0.1.0/24",
  availabilityZone: "us-east-1a",
  mapPublicIpOnLaunch: true
});

const privateRouteTable = await RouteTable("private-rt", {
  vpc,
  tags: {
    Name: "private-route-table"
  }
});

const natGateway = await NatGateway("main-nat", {
  subnet: publicSubnet
});

const natRoute = await Route("private-nat-route", {
  routeTable: privateRouteTable,
  destinationCidrBlock: "0.0.0.0/0",
  target: { natGateway: natGateway }
});
```

## Instance Route

Route traffic to a specific EC2 instance:

```ts
import { RouteTable, Route } from "alchemy/aws/ec2";

const instanceRoute = await Route("instance-route", {
  routeTable: customRouteTable,
  destinationCidrBlock: "10.1.0.0/16",
  target: { instanceId: "i-1234567890abcdef0" }
});
```

## Network Interface Route

Route traffic to a specific network interface:

```ts
import { RouteTable, Route } from "alchemy/aws/ec2";

const eniRoute = await Route("eni-route", {
  routeTable: firewallRouteTable,
  destinationCidrBlock: "10.2.0.0/16",
  target: { networkInterfaceId: "eni-1234567890abcdef0" }
});
```

## VPC Peering Route

Route traffic to a VPC peering connection:

```ts
import { RouteTable, Route } from "alchemy/aws/ec2";

const peeringRoute = await Route("peering-route", {
  routeTable: mainRouteTable,
  destinationCidrBlock: "10.1.0.0/16",
  target: { vpcPeeringConnectionId: "pcx-1234567890abcdef0" }
});
```

## Transit Gateway Route

Route traffic to a Transit Gateway:

```ts
import { RouteTable, Route } from "alchemy/aws/ec2";

const transitRoute = await Route("transit-route", {
  routeTable: transitRouteTable,
  destinationCidrBlock: "10.0.0.0/8",
  target: { transitGatewayId: "tgw-1234567890abcdef0" }
});
```

## Multi-AZ NAT Gateway Routes

Create routes for NAT Gateways in multiple availability zones:

```ts
import { 
  Vpc,
  Subnet,
  RouteTable,
  NatGateway,
  Route
} from "alchemy/aws/ec2";

const vpc = await Vpc("multi-az-vpc", {
  cidrBlock: "10.0.0.0/16"
});

// Public subnets for NAT Gateways
const publicSubnet1a = await Subnet("public-subnet-1a", {
  vpc,
  cidrBlock: "10.0.1.0/24",
  availabilityZone: "us-east-1a",
  mapPublicIpOnLaunch: true
});

const publicSubnet1b = await Subnet("public-subnet-1b", {
  vpc,
  cidrBlock: "10.0.2.0/24",
  availabilityZone: "us-east-1b",
  mapPublicIpOnLaunch: true
});

// NAT Gateways in each AZ
const natGateway1a = await NatGateway("nat-1a", {
  subnet: publicSubnet1a
});

const natGateway1b = await NatGateway("nat-1b", {
  subnet: publicSubnet1b
});

// Private route tables (one per AZ)
const privateRouteTable1a = await RouteTable("private-rt-1a", {
  vpc,
  tags: {
    Name: "private-route-table-1a",
    AvailabilityZone: "us-east-1a"
  }
});

const privateRouteTable1b = await RouteTable("private-rt-1b", {
  vpc,
  tags: {
    Name: "private-route-table-1b",
    AvailabilityZone: "us-east-1b"
  }
});

// Routes to NAT Gateways in same AZ
const natRoute1a = await Route("nat-route-1a", {
  routeTable: privateRouteTable1a,
  destinationCidrBlock: "0.0.0.0/0",
  target: { natGateway: natGateway1a }
});

const natRoute1b = await Route("nat-route-1b", {
  routeTable: privateRouteTable1b,
  destinationCidrBlock: "0.0.0.0/0",
  target: { natGateway: natGateway1b }
});
```

## Specific Network Routes

Create routes for specific networks or services:

```ts
import { RouteTable, Route } from "alchemy/aws/ec2";

// Route for corporate network
const corpNetworkRoute = await Route("corp-network-route", {
  routeTable: privateRouteTable,
  destinationCidrBlock: "192.168.0.0/16",
  target: { vpcPeeringConnectionId: "pcx-corporate" }
});

// Route for partner network
const partnerNetworkRoute = await Route("partner-network-route", {
  routeTable: partnerRouteTable,
  destinationCidrBlock: "172.16.0.0/12",
  target: { transitGatewayId: "tgw-partner-connection" }
});

// Route for development environment
const devNetworkRoute = await Route("dev-network-route", {
  routeTable: devRouteTable,
  destinationCidrBlock: "10.100.0.0/16",
  target: { vpcPeeringConnectionId: "pcx-dev-environment" }
});
```

## Failover Routes

Create backup routes for high availability:

```ts
import { RouteTable, Route } from "alchemy/aws/ec2";

// Primary internet route via main NAT Gateway
const primaryNatRoute = await Route("primary-nat-route", {
  routeTable: appRouteTable,
  destinationCidrBlock: "0.0.0.0/0",
  target: { natGateway: primaryNatGateway }
});

// Backup route (would be activated manually or via automation)
const backupNatRoute = await Route("backup-nat-route", {
  routeTable: backupRouteTable,
  destinationCidrBlock: "0.0.0.0/0",
  target: { natGateway: backupNatGateway }
});
```

## Custom Timeout

Configure timeout settings for slower environments:

```ts
import { RouteTable, Route } from "alchemy/aws/ec2";

const slowRoute = await Route("slow-environment-route", {
  routeTable,
  destinationCidrBlock: "0.0.0.0/0",
  target: { internetGateway: igw },
  timeout: {
    maxAttempts: 60,   // Increase attempts
    delayMs: 2000      // 2 second delay
  }
});
```

## Microservices Routing

Routes for microservices architecture:

```ts
import { RouteTable, Route } from "alchemy/aws/ec2";

// Route for microservices to shared services
const sharedServicesRoute = await Route("shared-services-route", {
  routeTable: microservicesRouteTable,
  destinationCidrBlock: "10.0.100.0/24",  // Shared services subnet
  target: { networkInterfaceId: "eni-shared-services-lb" }
});

// Route for logging and monitoring
const monitoringRoute = await Route("monitoring-route", {
  routeTable: microservicesRouteTable,
  destinationCidrBlock: "10.0.200.0/24",  // Monitoring subnet
  target: { instanceId: "i-monitoring-server" }
});
```

## Reference by IDs

Create routes using resource IDs:

```ts
import { Route } from "alchemy/aws/ec2";

const existingResourceRoute = await Route("existing-resource-route", {
  routeTable: "rtb-1234567890abcdef0",
  destinationCidrBlock: "0.0.0.0/0",
  target: { internetGateway: "igw-0987654321fedcba0" }
});
```

## Conditional Routes

Routes that depend on environment or conditions:

```ts
import { RouteTable, Route } from "alchemy/aws/ec2";

// Production route with high availability NAT
const prodRoute = await Route("prod-internet-route", {
  routeTable: prodRouteTable,
  destinationCidrBlock: "0.0.0.0/0",
  target: { natGateway: prodNatGateway }
});

// Development route with shared NAT for cost optimization
const devRoute = await Route("dev-internet-route", {
  routeTable: devRouteTable,
  destinationCidrBlock: "0.0.0.0/0",
  target: { natGateway: sharedDevNatGateway }
});
```

## Reference

Access route properties after creation:

```ts
const route = await Route("my-route", {
  routeTable,
  destinationCidrBlock: "0.0.0.0/0",
  target: { internetGateway: igw }
});

console.log(`Route Table ID: ${route.routeTableId}`);
console.log(`Destination CIDR: ${route.destinationCidrBlock}`);
console.log(`State: ${route.state}`);
console.log(`Origin: ${route.origin}`);
console.log(`Target:`, route.target);
```

:::tip
Use specific CIDR blocks instead of 0.0.0.0/0 when possible to create more secure and efficient routing rules.
:::

:::note
Routes are evaluated from most specific to least specific. More specific routes (smaller CIDR blocks) take precedence over less specific ones.
:::

:::caution
Each route table can have only one route for a specific destination CIDR block. Adding a route with the same destination will replace the existing route.
::: 