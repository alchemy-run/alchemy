---
title: RouteTable
description: Create and manage AWS Route Tables to control network traffic routing within VPCs.
---

An [AWS Route Table](https://docs.aws.amazon.com/vpc/latest/userguide/VPC_Route_Tables.html) contains rules (routes) that determine where network traffic is directed. Each subnet must be associated with a route table, which controls the routing for that subnet.

:::note
See AWS's official [Route Tables documentation](https://docs.aws.amazon.com/vpc/latest/userguide/VPC_Route_Tables.html) for more information.
:::

## Minimal Example

Create a basic route table:

```ts
import { Vpc, RouteTable } from "alchemy/aws/ec2";

const vpc = await Vpc("main-vpc", {
  cidrBlock: "10.0.0.0/16"
});

const routeTable = await RouteTable("main-route-table", {
  vpc: vpc
});
```

## Public Route Table

Create a route table for public subnets with descriptive tags:

```ts
import { Vpc, RouteTable } from "alchemy/aws/ec2";

const vpc = await Vpc("web-vpc", {
  cidrBlock: "10.0.0.0/16"
});

const publicRouteTable = await RouteTable("public-route-table", {
  vpc,
  tags: {
    Name: "public-route-table",
    Environment: "production",
    Type: "public",
    Purpose: "internet-access"
  }
});
```

## Private Route Table

Create a route table for private subnets:

```ts
import { Vpc, RouteTable } from "alchemy/aws/ec2";

const vpc = await Vpc("app-vpc", {
  cidrBlock: "10.0.0.0/16"
});

const privateRouteTable = await RouteTable("private-route-table", {
  vpc,
  tags: {
    Name: "private-route-table",
    Environment: "production", 
    Type: "private",
    Purpose: "internal-only"
  }
});
```

## Multi-AZ Route Tables

Create separate route tables for different availability zones:

```ts
import { Vpc, RouteTable } from "alchemy/aws/ec2";

const vpc = await Vpc("multi-az-vpc", {
  cidrBlock: "10.0.0.0/16"
});

// Public route table (shared across AZs)
const publicRouteTable = await RouteTable("public-rt", {
  vpc,
  tags: {
    Name: "public-route-table",
    Type: "public",
    Scope: "multi-az"
  }
});

// Private route tables (one per AZ for NAT Gateway failover)
const privateRouteTable1a = await RouteTable("private-rt-1a", {
  vpc,
  tags: {
    Name: "private-route-table-1a",
    Type: "private",
    AvailabilityZone: "us-east-1a"
  }
});

const privateRouteTable1b = await RouteTable("private-rt-1b", {
  vpc,
  tags: {
    Name: "private-route-table-1b",
    Type: "private", 
    AvailabilityZone: "us-east-1b"
  }
});

const privateRouteTable1c = await RouteTable("private-rt-1c", {
  vpc,
  tags: {
    Name: "private-route-table-1c",
    Type: "private",
    AvailabilityZone: "us-east-1c"
  }
});
```

## Database Route Table

Create an isolated route table for database subnets:

```ts
import { Vpc, RouteTable } from "alchemy/aws/ec2";

const vpc = await Vpc("database-vpc", {
  cidrBlock: "10.0.0.0/16"
});

const databaseRouteTable = await RouteTable("database-route-table", {
  vpc,
  tags: {
    Name: "database-route-table",
    Type: "isolated",
    Tier: "database",
    Purpose: "no-internet-access"
  }
});
```

## Complete Three-Tier Setup

Route tables for a three-tier architecture:

```ts
import { 
  Vpc,
  RouteTable,
  InternetGateway,
  InternetGatewayAttachment,
  NatGateway,
  Subnet,
  Route,
  RouteTableAssociation
} from "alchemy/aws/ec2";

const vpc = await Vpc("three-tier-vpc", {
  cidrBlock: "10.0.0.0/16",
  enableDnsHostnames: true,
  enableDnsSupport: true,
  tags: {
    Name: "three-tier-vpc"
  }
});

// Internet Gateway for public access
const igw = await InternetGateway("main-igw", {
  tags: {
    Name: "main-internet-gateway"
  }
});

const igwAttachment = await InternetGatewayAttachment("main-igw-attachment", {
  internetGateway: igw,
  vpc: vpc
});

// Public subnet and NAT Gateway
const publicSubnet = await Subnet("public-subnet", {
  vpc,
  cidrBlock: "10.0.1.0/24",
  availabilityZone: "us-east-1a",
  mapPublicIpOnLaunch: true
});

const natGateway = await NatGateway("main-nat", {
  subnet: publicSubnet
});

// Web tier route table (public)
const webRouteTable = await RouteTable("web-route-table", {
  vpc,
  tags: {
    Name: "web-tier-route-table",
    Tier: "web",
    Type: "public"
  }
});

// Application tier route table (private with NAT)
const appRouteTable = await RouteTable("app-route-table", {
  vpc,
  tags: {
    Name: "app-tier-route-table",
    Tier: "application",
    Type: "private"
  }
});

// Database tier route table (isolated)
const dbRouteTable = await RouteTable("db-route-table", {
  vpc,
  tags: {
    Name: "database-tier-route-table",
    Tier: "database",
    Type: "isolated"
  }
});

// Routes
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

// Database tier has no internet route - only local VPC traffic
```

## Microservices Route Tables

Route tables for microservices architecture:

```ts
import { Vpc, RouteTable } from "alchemy/aws/ec2";

const vpc = await Vpc("microservices-vpc", {
  cidrBlock: "10.0.0.0/16"
});

// API Gateway route table (public)
const apiGatewayRouteTable = await RouteTable("api-gateway-rt", {
  vpc,
  tags: {
    Name: "api-gateway-route-table",
    Service: "api-gateway",
    Type: "public"
  }
});

// Microservices route table (private)
const microservicesRouteTable = await RouteTable("microservices-rt", {
  vpc,
  tags: {
    Name: "microservices-route-table",
    Service: "microservices",
    Type: "private"
  }
});

// Shared services route table (private)
const sharedServicesRouteTable = await RouteTable("shared-services-rt", {
  vpc,
  tags: {
    Name: "shared-services-route-table",
    Service: "shared-services",
    Type: "private",
    Purpose: "databases-cache-monitoring"
  }
});
```

## Reference by VPC ID

Create a route table using VPC ID:

```ts
import { RouteTable } from "alchemy/aws/ec2";

const routeTable = await RouteTable("existing-vpc-rt", {
  vpc: "vpc-1234567890abcdef0",
  tags: {
    Name: "external-vpc-route-table"
  }
});
```

## Custom Timeout

Configure timeout settings for slower environments:

```ts
import { Vpc, RouteTable } from "alchemy/aws/ec2";

const vpc = await Vpc("slow-vpc", {
  cidrBlock: "10.0.0.0/16"
});

const routeTable = await RouteTable("slow-route-table", {
  vpc,
  timeout: {
    maxAttempts: 60,   // Increase attempts
    delayMs: 2000      // 2 second delay
  },
  tags: {
    Name: "slow-environment-route-table"
  }
});
```

## Environment-Based Route Tables

Different route tables for different environments:

```ts
import { Vpc, RouteTable } from "alchemy/aws/ec2";

const vpc = await Vpc("multi-env-vpc", {
  cidrBlock: "10.0.0.0/16"
});

// Development route table (more permissive)
const devRouteTable = await RouteTable("dev-route-table", {
  vpc,
  tags: {
    Name: "development-route-table",
    Environment: "development",
    AccessLevel: "permissive"
  }
});

// Staging route table
const stagingRouteTable = await RouteTable("staging-route-table", {
  vpc,
  tags: {
    Name: "staging-route-table",
    Environment: "staging",
    AccessLevel: "controlled"
  }
});

// Production route table (most restrictive)
const prodRouteTable = await RouteTable("prod-route-table", {
  vpc,
  tags: {
    Name: "production-route-table",
    Environment: "production",
    AccessLevel: "restrictive"
  }
});
```

## VPN Route Table

Route table for VPN connectivity:

```ts
import { Vpc, RouteTable } from "alchemy/aws/ec2";

const vpc = await Vpc("vpn-vpc", {
  cidrBlock: "10.0.0.0/16"
});

const vpnRouteTable = await RouteTable("vpn-route-table", {
  vpc,
  tags: {
    Name: "vpn-route-table",
    Type: "vpn",
    Purpose: "site-to-site-connectivity",
    OnPremisesCidr: "192.168.0.0/16"
  }
});
```

## Transit Gateway Route Table

Route table for Transit Gateway connectivity:

```ts
import { Vpc, RouteTable } from "alchemy/aws/ec2";

const vpc = await Vpc("tgw-vpc", {
  cidrBlock: "10.0.0.0/16"
});

const tgwRouteTable = await RouteTable("tgw-route-table", {
  vpc,
  tags: {
    Name: "transit-gateway-route-table",
    Type: "transit-gateway",
    Purpose: "cross-vpc-connectivity",
    AttachedTGW: "tgw-1234567890abcdef0"
  }
});
```

## Reference

Access route table properties after creation:

```ts
const routeTable = await RouteTable("my-route-table", {
  vpc,
  tags: {
    Name: "my-route-table"
  }
});

console.log(`Route Table ID: ${routeTable.routeTableId}`);
console.log(`VPC ID: ${routeTable.vpcId}`);
console.log(`Tags:`, routeTable.tags);
```

:::tip
Create separate route tables for different tiers or environments to provide fine-grained control over network traffic routing.
:::

:::note
Routes are managed separately using the `Route` resource, and subnet associations are managed using the `RouteTableAssociation` resource.
:::

:::caution
Every VPC has a main route table that cannot be deleted. Consider creating custom route tables for better control instead of modifying the main route table.
::: 