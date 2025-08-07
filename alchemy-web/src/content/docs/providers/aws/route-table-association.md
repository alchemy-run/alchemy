---
title: RouteTableAssociation
description: Associate AWS subnets with route tables to control subnet-level routing.
---

An [AWS Route Table Association](https://docs.aws.amazon.com/vpc/latest/userguide/VPC_Route_Tables.html#subnet-route-table-association) connects a subnet to a route table, determining how traffic from that subnet is routed. Each subnet must be associated with exactly one route table.

:::note
See AWS's official [Route Table Associations documentation](https://docs.aws.amazon.com/vpc/latest/userguide/VPC_Route_Tables.html#subnet-route-table-association) for more information.
:::

## Minimal Example

Associate a subnet with a route table:

```ts
import { 
  Vpc, 
  Subnet, 
  RouteTable, 
  RouteTableAssociation 
} from "alchemy/aws/ec2";

const vpc = await Vpc("main-vpc", {
  cidrBlock: "10.0.0.0/16"
});

const subnet = await Subnet("main-subnet", {
  vpc: vpc,
  cidrBlock: "10.0.1.0/24",
  availabilityZone: "us-east-1a"
});

const routeTable = await RouteTable("main-rt", {
  vpc: vpc
});

const association = await RouteTableAssociation("main-association", {
  routeTable,
  subnet
});
```

## Public Subnet Association

Associate public subnets with a public route table:

```ts
import { 
  Vpc,
  Subnet,
  RouteTable,
  InternetGateway,
  Route,
  RouteTableAssociation
} from "alchemy/aws/ec2";

const vpc = await Vpc("web-vpc", {
  cidrBlock: "10.0.0.0/16"
});

// Public subnets
const publicSubnet1a = await Subnet("public-subnet-1a", {
  vpc: vpc,
  cidrBlock: "10.0.1.0/24",
  availabilityZone: "us-east-1a",
  mapPublicIpOnLaunch: true,
  tags: {
    Name: "public-subnet-1a",
    Type: "public"
  }
});

const publicSubnet1b = await Subnet("public-subnet-1b", {
  vpc: vpc,
  cidrBlock: "10.0.2.0/24",
  availabilityZone: "us-east-1b",
  mapPublicIpOnLaunch: true,
  tags: {
    Name: "public-subnet-1b",
    Type: "public"
  }
});

// Public route table with internet access
const publicRouteTable = await RouteTable("public-rt", {
  vpc: vpc,
  tags: {
    Name: "public-route-table"
  }
});

const igw = await InternetGateway("web-igw", {});

const internetRoute = await Route("internet-route", {
  routeTable: publicRouteTable,
  destinationCidrBlock: "0.0.0.0/0",
  target: { internetGateway: igw }
});

// Associate public subnets with public route table
const publicAssociation1a = await RouteTableAssociation("public-association-1a", {
  routeTable: publicRouteTable,
  subnet: publicSubnet1a
});

const publicAssociation1b = await RouteTableAssociation("public-association-1b", {
  routeTable: publicRouteTable,
  subnet: publicSubnet1b
});
```

## Private Subnet Associations

Associate private subnets with different route tables per AZ:

```ts
import { 
  Vpc,
  Subnet,
  RouteTable,
  NatGateway,
  Route,
  RouteTableAssociation
} from "alchemy/aws/ec2";

const vpc = await Vpc("app-vpc", {
  cidrBlock: "10.0.0.0/16"
});

// Private subnets in different AZs
const privateSubnet1a = await Subnet("private-subnet-1a", {
  vpc: vpc,
  cidrBlock: "10.0.11.0/24",
  availabilityZone: "us-east-1a",
  tags: {
    Name: "private-subnet-1a",
    Type: "private"
  }
});

const privateSubnet1b = await Subnet("private-subnet-1b", {
  vpc: vpc,
  cidrBlock: "10.0.12.0/24",
  availabilityZone: "us-east-1b",
  tags: {
    Name: "private-subnet-1b",
    Type: "private"
  }
});

// Separate route tables for each AZ (for NAT Gateway failover)
const privateRouteTable1a = await RouteTable("private-rt-1a", {
  vpc: vpc,
  tags: {
    Name: "private-route-table-1a",
    AvailabilityZone: "us-east-1a"
  }
});

const privateRouteTable1b = await RouteTable("private-rt-1b", {
  vpc: vpc,
  tags: {
    Name: "private-route-table-1b",
    AvailabilityZone: "us-east-1b"
  }
});

// NAT Gateways in each AZ
const natGateway1a = await NatGateway("nat-1a", {
  subnet: publicSubnet1a  // Reference to public subnet
});

const natGateway1b = await NatGateway("nat-1b", {
  subnet: publicSubnet1b  // Reference to public subnet
});

// Routes to NAT Gateways
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

// Associate private subnets with their respective route tables
const privateAssociation1a = await RouteTableAssociation("private-association-1a", {
  routeTable: privateRouteTable1a,
  subnet: privateSubnet1a
});

const privateAssociation1b = await RouteTableAssociation("private-association-1b", {
  routeTable: privateRouteTable1b,
  subnet: privateSubnet1b
});
```

## Database Subnet Associations

Associate database subnets with isolated route tables:

```ts
import { 
  Vpc,
  Subnet,
  RouteTable,
  RouteTableAssociation
} from "alchemy/aws/ec2";

const vpc = await Vpc("database-vpc", {
  cidrBlock: "10.0.0.0/16"
});

// Database subnets (isolated, no internet access)
const dbSubnet1a = await Subnet("db-subnet-1a", {
  vpc: vpc,
  cidrBlock: "10.0.21.0/24",
  availabilityZone: "us-east-1a",
  tags: {
    Name: "database-subnet-1a",
    Type: "database"
  }
});

const dbSubnet1b = await Subnet("db-subnet-1b", {
  vpc: vpc,
  cidrBlock: "10.0.22.0/24",
  availabilityZone: "us-east-1b",
  tags: {
    Name: "database-subnet-1b",
    Type: "database"
  }
});

// Isolated route table (no internet routes)
const databaseRouteTable = await RouteTable("database-rt", {
  vpc: vpc,
  tags: {
    Name: "database-route-table",
    Type: "isolated"
  }
});

// Associate database subnets with isolated route table
const dbAssociation1a = await RouteTableAssociation("db-association-1a", {
  routeTable: databaseRouteTable,
  subnet: dbSubnet1a
});

const dbAssociation1b = await RouteTableAssociation("db-association-1b", {
  routeTable: databaseRouteTable,
  subnet: dbSubnet1b
});
```

## Three-Tier Architecture

Complete route table associations for three-tier architecture:

```ts
import { 
  Vpc,
  Subnet,
  RouteTable,
  InternetGateway,
  NatGateway,
  Route,
  RouteTableAssociation
} from "alchemy/aws/ec2";

const vpc = await Vpc("three-tier-vpc", {
  cidrBlock: "10.0.0.0/16"
});

// Web tier subnets (public)
const webSubnet1a = await Subnet("web-subnet-1a", {
  vpc: vpc,
  cidrBlock: "10.0.1.0/24",
  availabilityZone: "us-east-1a",
  mapPublicIpOnLaunch: true,
  tags: { Name: "web-subnet-1a", Tier: "web" }
});

const webSubnet1b = await Subnet("web-subnet-1b", {
  vpc: vpc,
  cidrBlock: "10.0.2.0/24",
  availabilityZone: "us-east-1b",
  mapPublicIpOnLaunch: true,
  tags: { Name: "web-subnet-1b", Tier: "web" }
});

// Application tier subnets (private)
const appSubnet1a = await Subnet("app-subnet-1a", {
  vpc: vpc,
  cidrBlock: "10.0.11.0/24",
  availabilityZone: "us-east-1a",
  tags: { Name: "app-subnet-1a", Tier: "application" }
});

const appSubnet1b = await Subnet("app-subnet-1b", {
  vpc: vpc,
  cidrBlock: "10.0.12.0/24",
  availabilityZone: "us-east-1b",
  tags: { Name: "app-subnet-1b", Tier: "application" }
});

// Database tier subnets (isolated)
const dbSubnet1a = await Subnet("db-subnet-1a", {
  vpc: vpc,
  cidrBlock: "10.0.21.0/24",
  availabilityZone: "us-east-1a",
  tags: { Name: "db-subnet-1a", Tier: "database" }
});

const dbSubnet1b = await Subnet("db-subnet-1b", {
  vpc: vpc,
  cidrBlock: "10.0.22.0/24",
  availabilityZone: "us-east-1b",
  tags: { Name: "db-subnet-1b", Tier: "database" }
});

// Route tables
const webRouteTable = await RouteTable("web-rt", {
  vpc: vpc,
  tags: { Name: "web-route-table", Tier: "web" }
});

const appRouteTable = await RouteTable("app-rt", {
  vpc: vpc,
  tags: { Name: "app-route-table", Tier: "application" }
});

const dbRouteTable = await RouteTable("db-rt", {
  vpc: vpc,
  tags: { Name: "database-route-table", Tier: "database" }
});

// Networking setup (IGW, NAT, routes)
const igw = await InternetGateway("main-igw", {});
const natGateway = await NatGateway("main-nat", { subnet: webSubnet1a });

const webInternetRoute = await Route("web-internet-route", {
  routeTable: webRouteTable,
  destinationCidrBlock: "0.0.0.0/0",
  target: { internetGateway: igw }
});

const appNatRoute = await Route("app-nat-route", {
  routeTable: appRouteTable,
  destinationCidrBlock: "0.0.0.0/0",
  target: { natGateway: natGateway }
});

// Associate subnets with appropriate route tables
const webAssociation1a = await RouteTableAssociation("web-association-1a", {
  routeTable: webRouteTable,
  subnet: webSubnet1a
});

const webAssociation1b = await RouteTableAssociation("web-association-1b", {
  routeTable: webRouteTable,
  subnet: webSubnet1b
});

const appAssociation1a = await RouteTableAssociation("app-association-1a", {
  routeTable: appRouteTable,
  subnet: appSubnet1a
});

const appAssociation1b = await RouteTableAssociation("app-association-1b", {
  routeTable: appRouteTable,
  subnet: appSubnet1b
});

const dbAssociation1a = await RouteTableAssociation("db-association-1a", {
  routeTable: dbRouteTable,
  subnet: dbSubnet1a
});

const dbAssociation1b = await RouteTableAssociation("db-association-1b", {
  routeTable: dbRouteTable,
  subnet: dbSubnet1b
});
```

## Reference by IDs

Create associations using resource IDs:

```ts
import { RouteTableAssociation } from "alchemy/aws/ec2";

const existingAssociation = await RouteTableAssociation("existing-association", {
  routeTable: "rtb-1234567890abcdef0",
  subnet: "subnet-0987654321fedcba0"
});
```

## Gateway Association

Associate route table with a gateway (less common):

```ts
import { RouteTableAssociation } from "alchemy/aws/ec2";

const gatewayAssociation = await RouteTableAssociation("gateway-association", {
  routeTable,
  gateway: "igw-1234567890abcdef0"
});
```

## Custom Timeout

Configure timeout settings for slower environments:

```ts
import { RouteTableAssociation } from "alchemy/aws/ec2";

const slowAssociation = await RouteTableAssociation("slow-association", {
  routeTable,
  subnet: subnet,
  timeout: {
    maxAttempts: 60,   // Increase attempts
    delayMs: 2000      // 2 second delay
  }
});
```

## Microservices Associations

Route table associations for microservices architecture:

```ts
import { 
  Vpc,
  Subnet,
  RouteTable,
  RouteTableAssociation
} from "alchemy/aws/ec2";

const vpc = await Vpc("microservices-vpc", {
  cidrBlock: "10.0.0.0/16"
});

// API Gateway subnet (public)
const apiSubnet = await Subnet("api-subnet", {
  vpc: vpc,
  cidrBlock: "10.0.1.0/24",
  availabilityZone: "us-east-1a",
  mapPublicIpOnLaunch: true,
  tags: { Name: "api-gateway-subnet", Service: "api-gateway" }
});

// Microservices subnets (private)
const servicesSubnet1a = await Subnet("services-subnet-1a", {
  vpc: vpc,
  cidrBlock: "10.0.11.0/24",
  availabilityZone: "us-east-1a",
  tags: { Name: "microservices-subnet-1a", Service: "microservices" }
});

const servicesSubnet1b = await Subnet("services-subnet-1b", {
  vpc: vpc,
  cidrBlock: "10.0.12.0/24",
  availabilityZone: "us-east-1b",
  tags: { Name: "microservices-subnet-1b", Service: "microservices" }
});

// Shared services subnet (private)
const sharedSubnet = await Subnet("shared-subnet", {
  vpc: vpc,
  cidrBlock: "10.0.21.0/24",
  availabilityZone: "us-east-1a",
  tags: { Name: "shared-services-subnet", Service: "shared-services" }
});

// Route tables
const apiRouteTable = await RouteTable("api-rt", {
  vpc: vpc,
  tags: { Name: "api-route-table", Service: "api-gateway" }
});

const servicesRouteTable = await RouteTable("services-rt", {
  vpc: vpc,
  tags: { Name: "microservices-route-table", Service: "microservices" }
});

const sharedRouteTable = await RouteTable("shared-rt", {
  vpc: vpc,
  tags: { Name: "shared-services-route-table", Service: "shared-services" }
});

// Associations
const apiAssociation = await RouteTableAssociation("api-association", {
  routeTable: apiRouteTable,
  subnet: apiSubnet
});

const servicesAssociation1a = await RouteTableAssociation("services-association-1a", {
  routeTable: servicesRouteTable,
  subnet: servicesSubnet1a
});

const servicesAssociation1b = await RouteTableAssociation("services-association-1b", {
  routeTable: servicesRouteTable,
  subnet: servicesSubnet1b
});

const sharedAssociation = await RouteTableAssociation("shared-association", {
  routeTable: sharedRouteTable,
  subnet: sharedSubnet
});
```

## Reference

Access association properties after creation:

```ts
const association = await RouteTableAssociation("my-association", {
  routeTable,
  subnet
});

console.log(`Association ID: ${association.associationId}`);
console.log(`Route Table ID: ${association.routeTableId}`);
console.log(`Subnet ID: ${association.subnetId}`);
console.log(`Is Main: ${association.isMain}`);
console.log(`State: ${association.state}`);
```

:::tip
Each subnet can only be associated with one route table at a time. Changing the association will automatically disassociate from the previous route table.
:::

:::note
If you don't explicitly associate a subnet with a route table, it will automatically be associated with the VPC's main route table.
:::

:::caution
Route table associations are critical for network connectivity. Ensure you understand the routing implications before making changes to existing associations.
::: 