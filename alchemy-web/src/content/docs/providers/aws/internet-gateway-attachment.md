---
title: InternetGatewayAttachment
description: Attach AWS Internet Gateways to VPCs to enable internet connectivity.
---

An [AWS Internet Gateway Attachment](https://docs.aws.amazon.com/vpc/latest/userguide/VPC_Internet_Gateway.html) creates the connection between an Internet Gateway and a VPC, enabling internet connectivity for resources within the VPC.

:::note
This is a separate resource to ensure proper dependency ordering and lifecycle management between Internet Gateways and VPCs.
:::

## Minimal Example

Attach an Internet Gateway to a VPC:

```ts
import { 
  Vpc, 
  InternetGateway, 
  InternetGatewayAttachment 
} from "alchemy/aws/ec2";

const vpc = await Vpc("main-vpc", {
  cidrBlock: "10.0.0.0/16"
});

const igw = await InternetGateway("main-igw", {});

const attachment = await InternetGatewayAttachment("main-igw-attachment", {
  internetGateway: igw,
  vpc: vpc
});
```

## Reference by IDs

Attach using existing resource IDs:

```ts
import { InternetGatewayAttachment } from "alchemy/aws/ec2";

const attachment = await InternetGatewayAttachment("existing-igw-attachment", {
  internetGateway: "igw-1234567890abcdef0",
  vpc: "vpc-0987654321fedcba0"
});
```

## Complete Internet Setup

Full setup with routing for internet connectivity:

```ts
import { 
  Vpc,
  InternetGateway,
  InternetGatewayAttachment,
  Subnet,
  RouteTable,
  Route,
  RouteTableAssociation
} from "alchemy/aws/ec2";

// Create VPC with DNS enabled
const vpc = await Vpc("web-vpc", {
  cidrBlock: "10.0.0.0/16",
  enableDnsHostnames: true,
  enableDnsSupport: true,
  tags: {
    Name: "web-vpc",
    Environment: "production"
  }
});

// Create Internet Gateway
const igw = await InternetGateway("web-igw", {
  tags: {
    Name: "web-internet-gateway"
  }
});

// Attach Internet Gateway to VPC
const attachment = await InternetGatewayAttachment("web-igw-attachment", {
  internetGateway: igw,
  vpc: vpc
});

// Create public subnet
const publicSubnet = await Subnet("public-subnet", {
  vpc,
  cidrBlock: "10.0.1.0/24",
  availabilityZone: "us-east-1a",
  mapPublicIpOnLaunch: true,
  tags: {
    Name: "public-subnet-1a",
    Type: "public"
  }
});

// Create route table for public access
const publicRouteTable = await RouteTable("public-rt", {
  vpc,
  tags: {
    Name: "public-route-table"
  }
});

// Add route to Internet Gateway (depends on attachment)
const internetRoute = await Route("internet-route", {
  routeTable: publicRouteTable,
  destinationCidrBlock: "0.0.0.0/0",
  target: { internetGateway: igw }
});

// Associate subnet with route table
const routeAssociation = await RouteTableAssociation("public-association", {
  routeTable: publicRouteTable,
  subnet: publicSubnet
});
```

## Multi-AZ Public Infrastructure

Attach Internet Gateway for high-availability setup:

```ts
import { 
  Vpc,
  InternetGateway,
  InternetGatewayAttachment,
  Subnet,
  RouteTable,
  Route,
  RouteTableAssociation
} from "alchemy/aws/ec2";

const vpc = await Vpc("ha-vpc", {
  cidrBlock: "10.0.0.0/16",
  enableDnsHostnames: true,
  enableDnsSupport: true
});

const igw = await InternetGateway("ha-igw", {
  tags: {
    Name: "high-availability-igw"
  }
});

const attachment = await InternetGatewayAttachment("ha-igw-attachment", {
  internetGateway: igw,
  vpc: vpc
});

// Public subnets in multiple availability zones
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

const publicSubnet1c = await Subnet("public-subnet-1c", {
  vpc,
  cidrBlock: "10.0.3.0/24",
  availabilityZone: "us-east-1c",
  mapPublicIpOnLaunch: true
});

// Single route table for all public subnets
const publicRouteTable = await RouteTable("public-rt", {
  vpc: vpc
});

const internetRoute = await Route("internet-route", {
  routeTable: publicRouteTable,
  destinationCidrBlock: "0.0.0.0/0",
  target: { internetGateway: igw }
});

// Associate all public subnets
const association1a = await RouteTableAssociation("public-association-1a", {
  routeTable: publicRouteTable,
  subnet: publicSubnet1a
});

const association1b = await RouteTableAssociation("public-association-1b", {
  routeTable: publicRouteTable,
  subnet: publicSubnet1b
});

const association1c = await RouteTableAssociation("public-association-1c", {
  routeTable: publicRouteTable,
  subnet: publicSubnet1c
});
```

## Custom Timeout Configuration

Handle slower environments with custom timeout settings:

```ts
import { 
  Vpc, 
  InternetGateway, 
  InternetGatewayAttachment 
} from "alchemy/aws/ec2";

const vpc = await Vpc("slow-vpc", {
  cidrBlock: "10.0.0.0/16"
});

const igw = await InternetGateway("slow-igw", {});

const attachment = await InternetGatewayAttachment("slow-igw-attachment", {
  internetGateway: igw,
  vpc,
  timeout: {
    maxAttempts: 120,  // Increase attempts for slower environments
    delayMs: 3000      // 3 second delay between checks
  }
});
```

## Web Application Architecture

Complete setup for a web application with public and private tiers:

```ts
import { 
  Vpc,
  InternetGateway,
  InternetGatewayAttachment,
  Subnet,
  RouteTable,
  Route,
  RouteTableAssociation,
  NatGateway
} from "alchemy/aws/ec2";

// VPC for web application
const webVpc = await Vpc("web-app-vpc", {
  cidrBlock: "10.0.0.0/16",
  enableDnsHostnames: true,
  enableDnsSupport: true,
  tags: {
    Name: "web-application-vpc",
    Project: "web-app"
  }
});

// Internet Gateway for public access
const webIgw = await InternetGateway("web-app-igw", {
  tags: {
    Name: "web-application-igw"
  }
});

// Attach Internet Gateway to VPC
const webAttachment = await InternetGatewayAttachment("web-app-igw-attachment", {
  internetGateway: webIgw,
  vpc: webVpc
});

// Public subnet for load balancers and NAT gateways
const publicSubnet = await Subnet("web-public-subnet", {
  vpc: webVpc,
  cidrBlock: "10.0.1.0/24",
  availabilityZone: "us-east-1a",
  mapPublicIpOnLaunch: true,
  tags: {
    Name: "web-public-subnet",
    Tier: "public"
  }
});

// Private subnet for application servers
const privateSubnet = await Subnet("web-private-subnet", {
  vpc: webVpc,
  cidrBlock: "10.0.10.0/24",
  availabilityZone: "us-east-1a",
  tags: {
    Name: "web-private-subnet",
    Tier: "private"
  }
});

// NAT Gateway for private subnet outbound access
const natGateway = await NatGateway("web-nat", {
  subnet: publicSubnet,
  tags: {
    Name: "web-nat-gateway"
  }
});

// Public route table
const publicRouteTable = await RouteTable("web-public-rt", {
  vpc: webVpc,
  tags: {
    Name: "web-public-routes"
  }
});

// Private route table
const privateRouteTable = await RouteTable("web-private-rt", {
  vpc: webVpc,
  tags: {
    Name: "web-private-routes"
  }
});

// Routes
const publicInternetRoute = await Route("web-public-internet", {
  routeTable: publicRouteTable,
  destinationCidrBlock: "0.0.0.0/0",
  target: { internetGateway: webIgw }
});

const privateNatRoute = await Route("web-private-nat", {
  routeTable: privateRouteTable,
  destinationCidrBlock: "0.0.0.0/0",
  target: { natGateway: natGateway }
});

// Route table associations
const publicAssociation = await RouteTableAssociation("web-public-association", {
  routeTable: publicRouteTable,
  subnet: publicSubnet
});

const privateAssociation = await RouteTableAssociation("web-private-association", {
  routeTable: privateRouteTable,
  subnet: privateSubnet
});
```

## Reference

Access attachment properties after creation:

```ts
const attachment = await InternetGatewayAttachment("my-attachment", {
  internetGateway: igw,
  vpc: vpc
});

console.log(`Internet Gateway ID: ${attachment.internetGatewayId}`);
console.log(`VPC ID: ${attachment.vpcId}`);
console.log(`Attachment State: ${attachment.state}`);
```

:::tip
The Internet Gateway attachment is typically one of the first resources you'll create when setting up internet connectivity for a VPC.
:::

:::caution
Each VPC can have only one Internet Gateway attached. The attachment will fail if the VPC already has an Internet Gateway attached.
::: 