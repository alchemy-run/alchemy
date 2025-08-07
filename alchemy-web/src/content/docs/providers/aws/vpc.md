---
title: VPC
description: Create and manage AWS Virtual Private Clouds (VPCs) for isolated network environments.
---

An [AWS VPC (Virtual Private Cloud)](https://docs.aws.amazon.com/vpc/latest/userguide/what-is-amazon-vpc.html) provides an isolated virtual network environment within AWS where you can launch resources with full control over networking configuration.

:::note
See AWS's official [VPC documentation](https://docs.aws.amazon.com/vpc/latest/userguide/) for more information.
:::

## Minimal Example

Create a basic VPC with DNS support:

```ts
import { Vpc } from "alchemy/aws/ec2";

const vpc = await Vpc("main-vpc", {
  cidrBlock: "10.0.0.0/16"
});
```

## DNS Configuration

Control DNS settings for your VPC:

```ts
import { Vpc } from "alchemy/aws/ec2";

const vpc = await Vpc("dns-enabled-vpc", {
  cidrBlock: "10.0.0.0/16",
  enableDnsSupport: true,     // Enable DNS resolution (default: true)
  enableDnsHostnames: true,   // Enable DNS hostnames (default: true)
});
```

:::tip
Both `enableDnsSupport` and `enableDnsHostnames` should typically be enabled for most use cases, especially when using internet connectivity.
:::

## Instance Tenancy

Configure tenancy for EC2 instances launched in the VPC:

```ts
import { Vpc } from "alchemy/aws/ec2";

// Default tenancy (shared hardware)
const sharedVpc = await Vpc("shared-vpc", {
  cidrBlock: "10.0.0.0/16",
  instanceTenancy: "default" // default value
});

// Dedicated tenancy (dedicated hardware)
const dedicatedVpc = await Vpc("dedicated-vpc", {
  cidrBlock: "10.1.0.0/16", 
  instanceTenancy: "dedicated"
});
```

:::caution
Dedicated tenancy incurs additional costs. Use only when required for compliance or performance reasons.
:::

## Additional IPv4 CIDR Blocks

Add secondary CIDR blocks to expand your VPC's address space:

```ts
import { Vpc } from "alchemy/aws/ec2";

const vpc = await Vpc("multi-cidr-vpc", {
  cidrBlock: "10.0.0.0/16",
  additionalCidrBlocks: [
    "10.1.0.0/16",
    "172.16.0.0/16"
  ]
});
```

## IPv6 Configuration

Enable IPv6 support with Amazon-provided IPv6 CIDR blocks:

```ts
import { Vpc } from "alchemy/aws/ec2";

const ipv6Vpc = await Vpc("ipv6-vpc", {
  cidrBlock: "10.0.0.0/16",
  ipv6Config: {
    amazonProvidedIpv6CidrBlock: true,
    ipv6CidrBlockNetworkBorderGroup: "us-east-1"
  }
});
```

## Tags

Apply tags for organization and billing:

```ts
import { Vpc } from "alchemy/aws/ec2";

const taggedVpc = await Vpc("production-vpc", {
  cidrBlock: "10.0.0.0/16",
  tags: {
    Name: "production-vpc",
    Environment: "production",
    Project: "web-app",
    Owner: "platform-team"
  }
});
```

## Timeout Configuration

Customize timeout settings for VPC operations:

```ts
import { Vpc } from "alchemy/aws/ec2";

const vpc = await Vpc("slow-environment-vpc", {
  cidrBlock: "10.0.0.0/16",
  timeout: {
    maxAttempts: 120,  // Increase for slower environments
    delayMs: 3000      // 3 second delay between attempts
  }
});
```

## Complete Network Setup

Example of a production-ready VPC with public and private subnets:

```ts
import { 
  Vpc, 
  Subnet, 
  InternetGateway, 
  InternetGatewayAttachment,
  RouteTable,
  Route,
  RouteTableAssociation,
  NatGateway
} from "alchemy/aws/ec2";

// Create the main VPC
const vpc = await Vpc("production-vpc", {
  cidrBlock: "10.0.0.0/16",
  enableDnsSupport: true,
  enableDnsHostnames: true,
  tags: {
    Name: "production-vpc",
    Environment: "production"
  }
});

// Create Internet Gateway for public access
const igw = await InternetGateway("main-igw", {
  tags: {
    Name: "main-internet-gateway"
  }
});

// Attach Internet Gateway to VPC
const igwAttachment = await InternetGatewayAttachment("main-igw-attachment", {
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

// Create private subnet
const privateSubnet = await Subnet("private-subnet", {
  vpc,
  cidrBlock: "10.0.2.0/24", 
  availabilityZone: "us-east-1a",
  tags: {
    Name: "private-subnet-1a",
    Type: "private"
  }
});

// Create NAT Gateway for private subnet internet access
const natGateway = await NatGateway("main-nat", {
  subnet: publicSubnet,
  tags: {
    Name: "main-nat-gateway"
  }
});

// Create public route table
const publicRouteTable = await RouteTable("public-rt", {
  vpc,
  tags: {
    Name: "public-route-table"
  }
});

// Create private route table
const privateRouteTable = await RouteTable("private-rt", {
  vpc,
  tags: {
    Name: "private-route-table"
  }
});

// Add internet route to public route table
const publicRoute = await Route("public-internet-route", {
  routeTable: publicRouteTable,
  destinationCidrBlock: "0.0.0.0/0",
  target: { internetGateway: igw }
});

// Add NAT route to private route table
const privateRoute = await Route("private-internet-route", {
  routeTable: privateRouteTable,
  destinationCidrBlock: "0.0.0.0/0",
  target: { natGateway: natGateway }
});

// Associate subnets with route tables
const publicAssociation = await RouteTableAssociation("public-association", {
  routeTable: publicRouteTable,
  subnet: publicSubnet
});

const privateAssociation = await RouteTableAssociation("private-association", {
  routeTable: privateRouteTable,
  subnet: privateSubnet
});
```

## Reference

Access VPC properties after creation:

```ts
const vpc = await Vpc("my-vpc", {
  cidrBlock: "10.0.0.0/16"
});

console.log(`VPC ID: ${vpc.vpcId}`);
console.log(`State: ${vpc.state}`);
console.log(`CIDR Block: ${vpc.cidrBlock}`);
console.log(`Is Default: ${vpc.isDefault}`);
``` 