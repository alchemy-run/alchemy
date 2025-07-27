---
title: SecurityGroup
description: Create and manage AWS Security Groups to control network traffic for EC2 instances and other resources.
---

An [AWS Security Group](https://docs.aws.amazon.com/vpc/latest/userguide/VPC_SecurityGroups.html) acts as a virtual firewall that controls inbound and outbound traffic for EC2 instances and other AWS resources. Security Groups are stateful, meaning return traffic is automatically allowed.

:::note
See AWS's official [Security Groups documentation](https://docs.aws.amazon.com/vpc/latest/userguide/VPC_SecurityGroups.html) for more information.
:::

## Minimal Example

Create a basic security group:

```ts
import { Vpc, SecurityGroup } from "alchemy/aws/ec2";

const vpc = await Vpc("main-vpc", {
  cidrBlock: "10.0.0.0/16"
});

const securityGroup = await SecurityGroup("web-sg", {
  vpc,
  groupName: "web-server-sg",
  description: "Security group for web servers"
});
```

## Web Server Security Group

Create a security group for web servers with descriptive tags:

```ts
import { Vpc, SecurityGroup } from "alchemy/aws/ec2";

const vpc = await Vpc("web-vpc", {
  cidrBlock: "10.0.0.0/16"
});

const webSecurityGroup = await SecurityGroup("web-sg", {
  vpc,
  groupName: "web-server-security-group",
  description: "Security group for web servers allowing HTTP and HTTPS",
  tags: {
    Name: "web-server-sg",
    Environment: "production",
    Tier: "web",
    Purpose: "load-balancer-targets"
  }
});
```

## Database Security Group

Create a security group for database servers:

```ts
import { Vpc, SecurityGroup } from "alchemy/aws/ec2";

const vpc = await Vpc("app-vpc", {
  cidrBlock: "10.0.0.0/16"
});

const databaseSecurityGroup = await SecurityGroup("db-sg", {
  vpc,
  groupName: "database-security-group",
  description: "Security group for database servers",
  tags: {
    Name: "database-sg",
    Environment: "production",
    Tier: "database",
    Purpose: "mysql-postgresql-servers"
  }
});
```

## Application Server Security Group

Security group for application tier servers:

```ts
import { Vpc, SecurityGroup } from "alchemy/aws/ec2";

const vpc = await Vpc("app-vpc", {
  cidrBlock: "10.0.0.0/16"
});

const appSecurityGroup = await SecurityGroup("app-sg", {
  vpc,
  groupName: "application-security-group",
  description: "Security group for application servers",
  tags: {
    Name: "application-sg",
    Environment: "production",
    Tier: "application",
    Purpose: "api-servers"
  }
});
```

## Multi-Tier Architecture

Create security groups for a complete three-tier architecture:

```ts
import { Vpc, SecurityGroup } from "alchemy/aws/ec2";

const vpc = await Vpc("three-tier-vpc", {
  cidrBlock: "10.0.0.0/16",
  tags: {
    Name: "three-tier-architecture"
  }
});

// Load balancer security group (public)
const lbSecurityGroup = await SecurityGroup("lb-sg", {
  vpc,
  groupName: "load-balancer-sg",
  description: "Security group for Application Load Balancer",
  tags: {
    Name: "load-balancer-sg",
    Tier: "public",
    Purpose: "external-load-balancer"
  }
});

// Web tier security group
const webSecurityGroup = await SecurityGroup("web-sg", {
  vpc,
  groupName: "web-tier-sg",
  description: "Security group for web servers",
  tags: {
    Name: "web-tier-sg",
    Tier: "web",
    Purpose: "web-servers"
  }
});

// Application tier security group
const appSecurityGroup = await SecurityGroup("app-sg", {
  vpc,
  groupName: "app-tier-sg",
  description: "Security group for application servers",
  tags: {
    Name: "app-tier-sg",
    Tier: "application",
    Purpose: "api-servers"
  }
});

// Database tier security group
const dbSecurityGroup = await SecurityGroup("db-sg", {
  vpc,
  groupName: "db-tier-sg",
  description: "Security group for database servers",
  tags: {
    Name: "db-tier-sg",
    Tier: "database",
    Purpose: "database-servers"
  }
});
```

## Reference by VPC ID

Create security group using VPC ID instead of resource reference:

```ts
import { SecurityGroup } from "alchemy/aws/ec2";

const securityGroup = await SecurityGroup("existing-vpc-sg", {
  vpc: "vpc-1234567890abcdef0",
  groupName: "api-security-group",
  description: "Security group for API servers"
});
```

## Custom Timeout

Configure timeout settings for slower environments:

```ts
import { Vpc, SecurityGroup } from "alchemy/aws/ec2";

const vpc = await Vpc("slow-vpc", {
  cidrBlock: "10.0.0.0/16"
});

const securityGroup = await SecurityGroup("slow-sg", {
  vpc,
  groupName: "slow-environment-sg",
  description: "Security group with custom timeout",
  timeout: {
    maxAttempts: 60,   // Increase attempts
    delayMs: 2000      // 2 second delay
  },
  tags: {
    Name: "slow-environment-sg"
  }
});
```

## Development vs Production

Different security groups for different environments:

```ts
import { Vpc, SecurityGroup } from "alchemy/aws/ec2";

const vpc = await Vpc("env-vpc", {
  cidrBlock: "10.0.0.0/16"
});

// Development security group (more permissive)
const devSecurityGroup = await SecurityGroup("dev-sg", {
  vpc,
  groupName: "development-sg",
  description: "Security group for development environment",
  tags: {
    Name: "development-sg",
    Environment: "development",
    AccessLevel: "permissive"
  }
});

// Production security group (restrictive)
const prodSecurityGroup = await SecurityGroup("prod-sg", {
  vpc,
  groupName: "production-sg",
  description: "Security group for production environment",
  tags: {
    Name: "production-sg",
    Environment: "production",
    AccessLevel: "restrictive"
  }
});
```

## Microservices Architecture

Security groups for microservices with clear naming:

```ts
import { Vpc, SecurityGroup } from "alchemy/aws/ec2";

const vpc = await Vpc("microservices-vpc", {
  cidrBlock: "10.0.0.0/16"
});

// API Gateway security group
const apiGatewaySecurityGroup = await SecurityGroup("api-gateway-sg", {
  vpc,
  groupName: "api-gateway-sg",
  description: "Security group for API Gateway",
  tags: {
    Name: "api-gateway-sg",
    Service: "api-gateway",
    Role: "entry-point"
  }
});

// User service security group
const userServiceSecurityGroup = await SecurityGroup("user-service-sg", {
  vpc,
  groupName: "user-service-sg",
  description: "Security group for User Service",
  tags: {
    Name: "user-service-sg",
    Service: "user-service",
    Role: "microservice"
  }
});

// Order service security group
const orderServiceSecurityGroup = await SecurityGroup("order-service-sg", {
  vpc,
  groupName: "order-service-sg",
  description: "Security group for Order Service",
  tags: {
    Name: "order-service-sg",
    Service: "order-service",
    Role: "microservice"
  }
});

// Shared database security group
const sharedDbSecurityGroup = await SecurityGroup("shared-db-sg", {
  vpc,
  groupName: "shared-database-sg",
  description: "Security group for shared database",
  tags: {
    Name: "shared-database-sg",
    Service: "database",
    Role: "data-store"
  }
});
```

## Reference

Access security group properties after creation:

```ts
const securityGroup = await SecurityGroup("my-sg", {
  vpc,
  groupName: "my-security-group",
  description: "My security group"
});

console.log(`Security Group ID: ${securityGroup.groupId}`);
console.log(`VPC ID: ${securityGroup.vpcId}`);
console.log(`Group Name: ${securityGroup.groupName}`);
console.log(`Description: ${securityGroup.description}`);
console.log(`Owner ID: ${securityGroup.ownerId}`);
```

:::tip
Security group rules are managed separately using the `SecurityGroupRule` resource. This allows for better control and dependency management of individual rules.
:::

:::note
Security groups are stateful, meaning if you allow inbound traffic on a specific port, the corresponding outbound traffic is automatically allowed.
:::

:::caution
Security group names must be unique within a VPC. Choose descriptive names that clearly indicate the purpose and environment.
::: 