---
title: Subnet
description: Create and manage AWS subnets within VPCs for segmenting network traffic.
---

An [AWS Subnet](https://docs.aws.amazon.com/vpc/latest/userguide/configure-subnets.html) is a range of IP addresses within a VPC that allows you to segment your network and place resources in different availability zones.

:::note
See AWS's official [Subnet documentation](https://docs.aws.amazon.com/vpc/latest/userguide/configure-subnets.html) for more information.
:::

## Minimal Example

Create a basic subnet within a VPC:

```ts
import { Vpc, Subnet } from "alchemy/aws/ec2";

const vpc = await Vpc("main-vpc", {
  cidrBlock: "10.0.0.0/16"
});

const subnet = await Subnet("main-subnet", {
  vpc,
  cidrBlock: "10.0.1.0/24",
  availabilityZone: "us-east-1a"
});
```

## Public Subnet

Create a public subnet that assigns public IP addresses to instances:

```ts
import { Vpc, Subnet } from "alchemy/aws/ec2";

const vpc = await Vpc("web-vpc", {
  cidrBlock: "10.0.0.0/16"
});

const publicSubnet = await Subnet("public-subnet", {
  vpc,
  cidrBlock: "10.0.1.0/24",
  availabilityZone: "us-east-1a",
  mapPublicIpOnLaunch: true,  // Auto-assign public IPs
  tags: {
    Name: "public-subnet-1a",
    Type: "public"
  }
});
```

## Private Subnet

Create a private subnet for internal resources:

```ts
import { Vpc, Subnet } from "alchemy/aws/ec2";

const vpc = await Vpc("app-vpc", {
  cidrBlock: "10.0.0.0/16"
});

const privateSubnet = await Subnet("private-subnet", {
  vpc,
  cidrBlock: "10.0.2.0/24",
  availabilityZone: "us-east-1a",
  mapPublicIpOnLaunch: false, // No public IPs (default)
  tags: {
    Name: "private-subnet-1a",
    Type: "private"
  }
});
```

## Multi-AZ Setup

Create subnets across multiple availability zones for high availability:

```ts
import { Vpc, Subnet } from "alchemy/aws/ec2";

const vpc = await Vpc("ha-vpc", {
  cidrBlock: "10.0.0.0/16"
});

// Public subnets in different AZs
const publicSubnet1a = await Subnet("public-subnet-1a", {
  vpc,
  cidrBlock: "10.0.1.0/24",
  availabilityZone: "us-east-1a",
  mapPublicIpOnLaunch: true,
  tags: {
    Name: "public-subnet-1a",
    Type: "public"
  }
});

const publicSubnet1b = await Subnet("public-subnet-1b", {
  vpc,
  cidrBlock: "10.0.2.0/24",
  availabilityZone: "us-east-1b",
  mapPublicIpOnLaunch: true,
  tags: {
    Name: "public-subnet-1b", 
    Type: "public"
  }
});

// Private subnets in different AZs
const privateSubnet1a = await Subnet("private-subnet-1a", {
  vpc,
  cidrBlock: "10.0.11.0/24",
  availabilityZone: "us-east-1a",
  tags: {
    Name: "private-subnet-1a",
    Type: "private"
  }
});

const privateSubnet1b = await Subnet("private-subnet-1b", {
  vpc,
  cidrBlock: "10.0.12.0/24",
  availabilityZone: "us-east-1b",
  tags: {
    Name: "private-subnet-1b",
    Type: "private"
  }
});
```

## Database Subnets

Create isolated subnets for database resources:

```ts
import { Vpc, Subnet } from "alchemy/aws/ec2";

const vpc = await Vpc("database-vpc", {
  cidrBlock: "10.0.0.0/16"
});

const dbSubnet1a = await Subnet("db-subnet-1a", {
  vpc,
  cidrBlock: "10.0.21.0/24",
  availabilityZone: "us-east-1a",
  tags: {
    Name: "database-subnet-1a",
    Type: "database",
    Tier: "data"
  }
});

const dbSubnet1b = await Subnet("db-subnet-1b", {
  vpc,
  cidrBlock: "10.0.22.0/24",
  availabilityZone: "us-east-1b",
  tags: {
    Name: "database-subnet-1b",
    Type: "database", 
    Tier: "data"
  }
});
```

## Referencing by ID

Reference an existing subnet by its ID:

```ts
import { Subnet } from "alchemy/aws/ec2";

const existingSubnet = await Subnet("existing-subnet", {
  vpc: "vpc-12345678",
  cidrBlock: "10.0.1.0/24",
  availabilityZone: "us-east-1a"
});
```

## Custom Timeout

Configure timeout settings for slower environments:

```ts
import { Vpc, Subnet } from "alchemy/aws/ec2";

const vpc = await Vpc("slow-vpc", {
  cidrBlock: "10.0.0.0/16"
});

const subnet = await Subnet("slow-subnet", {
  vpc,
  cidrBlock: "10.0.1.0/24",
  availabilityZone: "us-east-1a",
  timeout: {
    maxAttempts: 60,   // Increase attempts
    delayMs: 2000      // 2 second delay
  }
});
```

## Three-Tier Architecture

Create subnets for a typical three-tier architecture:

```ts
import { Vpc, Subnet } from "alchemy/aws/ec2";

const vpc = await Vpc("three-tier-vpc", {
  cidrBlock: "10.0.0.0/16",
  tags: {
    Name: "three-tier-architecture",
    Environment: "production"
  }
});

// Web tier (public subnets)
const webSubnet1a = await Subnet("web-subnet-1a", {
  vpc,
  cidrBlock: "10.0.1.0/24",
  availabilityZone: "us-east-1a",
  mapPublicIpOnLaunch: true,
  tags: {
    Name: "web-tier-1a",
    Tier: "web"
  }
});

const webSubnet1b = await Subnet("web-subnet-1b", {
  vpc,
  cidrBlock: "10.0.2.0/24",
  availabilityZone: "us-east-1b",
  mapPublicIpOnLaunch: true,
  tags: {
    Name: "web-tier-1b",
    Tier: "web"
  }
});

// Application tier (private subnets)
const appSubnet1a = await Subnet("app-subnet-1a", {
  vpc,
  cidrBlock: "10.0.11.0/24",
  availabilityZone: "us-east-1a",
  tags: {
    Name: "app-tier-1a",
    Tier: "application"
  }
});

const appSubnet1b = await Subnet("app-subnet-1b", {
  vpc,
  cidrBlock: "10.0.12.0/24",
  availabilityZone: "us-east-1b",
  tags: {
    Name: "app-tier-1b",
    Tier: "application"
  }
});

// Database tier (isolated private subnets)
const dbSubnet1a = await Subnet("db-subnet-1a", {
  vpc,
  cidrBlock: "10.0.21.0/24",
  availabilityZone: "us-east-1a",
  tags: {
    Name: "database-tier-1a",
    Tier: "database"
  }
});

const dbSubnet1b = await Subnet("db-subnet-1b", {
  vpc,
  cidrBlock: "10.0.22.0/24",
  availabilityZone: "us-east-1b",
  tags: {
    Name: "database-tier-1b",
    Tier: "database"
  }
});
```

## Reference

Access subnet properties after creation:

```ts
const subnet = await Subnet("my-subnet", {
  vpc,
  cidrBlock: "10.0.1.0/24",
  availabilityZone: "us-east-1a"
});

console.log(`Subnet ID: ${subnet.subnetId}`);
console.log(`VPC ID: ${subnet.vpcId}`);
console.log(`State: ${subnet.state}`);
console.log(`Available IPs: ${subnet.availableIpAddressCount}`);
console.log(`Default for AZ: ${subnet.defaultForAz}`);
```

:::tip
Use consistent CIDR block sizing (e.g., /24 for 256 addresses) to simplify network management and leave room for growth.
::: 