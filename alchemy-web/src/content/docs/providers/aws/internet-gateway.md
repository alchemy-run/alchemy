---
title: InternetGateway
description: Create and manage AWS Internet Gateways to provide internet connectivity for VPC resources.
---

An [AWS Internet Gateway](https://docs.aws.amazon.com/vpc/latest/userguide/VPC_Internet_Gateway.html) enables communication between instances in your VPC and the internet. It provides a target for internet-routable traffic and performs network address translation (NAT) for instances with public IP addresses.

:::note
See AWS's official [Internet Gateway documentation](https://docs.aws.amazon.com/vpc/latest/userguide/VPC_Internet_Gateway.html) for more information.
:::

## Minimal Example

Create a basic Internet Gateway:

```ts
import { InternetGateway } from "alchemy/aws/ec2";

const igw = await InternetGateway("main-igw", {});
```

## With Tags

Create an Internet Gateway with descriptive tags:

```ts
import { InternetGateway } from "alchemy/aws/ec2";

const igw = await InternetGateway("production-igw", {
  tags: {
    Name: "production-internet-gateway",
    Environment: "production",
    Project: "web-app"
  }
});
```

## Complete Setup with VPC

Internet Gateway with VPC attachment and routing:

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

// Create VPC
const vpc = await Vpc("web-vpc", {
  cidrBlock: "10.0.0.0/16",
  enableDnsHostnames: true,
  enableDnsSupport: true
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
  mapPublicIpOnLaunch: true
});

// Create route table for public subnet
const publicRouteTable = await RouteTable("public-rt", {
  vpc,
  tags: {
    Name: "public-route-table"
  }
});

// Add route to Internet Gateway
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

Create Internet Gateway for multi-availability zone setup:

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

const vpc = await Vpc("multi-az-vpc", {
  cidrBlock: "10.0.0.0/16",
  enableDnsHostnames: true,
  enableDnsSupport: true,
  tags: {
    Name: "multi-az-vpc",
    Environment: "production"
  }
});

const igw = await InternetGateway("multi-az-igw", {
  tags: {
    Name: "multi-az-internet-gateway",
    Environment: "production"
  }
});

const attachment = await InternetGatewayAttachment("multi-az-igw-attachment", {
  internetGateway: igw,
  vpc: vpc
});

// Public subnets in multiple AZs
const publicSubnet1a = await Subnet("public-subnet-1a", {
  vpc,
  cidrBlock: "10.0.1.0/24",
  availabilityZone: "us-east-1a",
  mapPublicIpOnLaunch: true,
  tags: {
    Name: "public-subnet-1a"
  }
});

const publicSubnet1b = await Subnet("public-subnet-1b", {
  vpc,
  cidrBlock: "10.0.2.0/24",
  availabilityZone: "us-east-1b",
  mapPublicIpOnLaunch: true,
  tags: {
    Name: "public-subnet-1b"
  }
});

// Shared route table for all public subnets
const publicRouteTable = await RouteTable("public-rt", {
  vpc,
  tags: {
    Name: "public-route-table"
  }
});

const internetRoute = await Route("internet-route", {
  routeTable: publicRouteTable,
  destinationCidrBlock: "0.0.0.0/0",
  target: { internetGateway: igw }
});

// Associate both subnets with the same route table
const association1a = await RouteTableAssociation("public-association-1a", {
  routeTable: publicRouteTable,
  subnet: publicSubnet1a
});

const association1b = await RouteTableAssociation("public-association-1b", {
  routeTable: publicRouteTable,
  subnet: publicSubnet1b
});
```

## Custom Timeout

Configure timeout settings for slower environments:

```ts
import { InternetGateway } from "alchemy/aws/ec2";

const igw = await InternetGateway("slow-environment-igw", {
  timeout: {
    maxAttempts: 90,   // Increase attempts
    delayMs: 3000      // 3 second delay
  },
  tags: {
    Name: "slow-environment-igw"
  }
});
```

## Reference by ID

Work with existing Internet Gateway by referencing its ID:

```ts
import { InternetGatewayAttachment } from "alchemy/aws/ec2";

// Attach existing Internet Gateway to VPC
const attachment = await InternetGatewayAttachment("existing-igw-attachment", {
  internetGateway: "igw-1234567890abcdef0",  // Existing IGW ID
  vpc: vpc
});
```

## Load Balancer Setup

Internet Gateway configuration for Application Load Balancer:

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

const vpc = await Vpc("alb-vpc", {
  cidrBlock: "10.0.0.0/16",
  enableDnsHostnames: true,
  enableDnsSupport: true
});

const igw = await InternetGateway("alb-igw", {
  tags: {
    Name: "alb-internet-gateway",
    Purpose: "load-balancer"
  }
});

const attachment = await InternetGatewayAttachment("alb-igw-attachment", {
  internetGateway: igw,
  vpc: vpc
});

// Create public subnets for ALB (requires at least 2 AZs)
const albSubnet1a = await Subnet("alb-subnet-1a", {
  vpc,
  cidrBlock: "10.0.1.0/24",
  availabilityZone: "us-east-1a",
  mapPublicIpOnLaunch: true,
  tags: {
    Name: "alb-subnet-1a",
    Purpose: "load-balancer"
  }
});

const albSubnet1b = await Subnet("alb-subnet-1b", {
  vpc,
  cidrBlock: "10.0.2.0/24",
  availabilityZone: "us-east-1b",
  mapPublicIpOnLaunch: true,
  tags: {
    Name: "alb-subnet-1b",
    Purpose: "load-balancer"
  }
});

const publicRouteTable = await RouteTable("alb-public-rt", {
  vpc,
  tags: {
    Name: "alb-public-route-table"
  }
});

const internetRoute = await Route("alb-internet-route", {
  routeTable: publicRouteTable,
  destinationCidrBlock: "0.0.0.0/0",
  target: { internetGateway: igw }
});

const association1a = await RouteTableAssociation("alb-association-1a", {
  routeTable: publicRouteTable,
  subnet: albSubnet1a
});

const association1b = await RouteTableAssociation("alb-association-1b", {
  routeTable: publicRouteTable,
  subnet: albSubnet1b
});
```

## Reference

Access Internet Gateway properties after creation:

```ts
const igw = await InternetGateway("my-igw", {
  tags: {
    Name: "my-internet-gateway"
  }
});

console.log(`Internet Gateway ID: ${igw.internetGatewayId}`);
console.log(`State: ${igw.state}`);
console.log(`Owner ID: ${igw.ownerId}`);
console.log(`Attachments:`, igw.attachments);
```

:::tip
An Internet Gateway must be attached to a VPC using `InternetGatewayAttachment` before it can route traffic. See the [InternetGatewayAttachment](/providers/aws/internet-gateway-attachment) documentation.
:::

:::caution
Each VPC can have only one Internet Gateway attached at a time. Attempting to attach multiple Internet Gateways to the same VPC will fail.
::: 