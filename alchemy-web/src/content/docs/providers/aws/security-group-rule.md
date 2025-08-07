---
title: SecurityGroupRule
description: Create and manage individual traffic rules for AWS Security Groups.
---

An [AWS Security Group Rule](https://docs.aws.amazon.com/vpc/latest/userguide/VPC_SecurityGroups.html#SecurityGroupRules) defines a specific inbound or outbound traffic rule for a security group, controlling access to EC2 instances and other AWS resources.

:::note
See AWS's official [Security Group Rules documentation](https://docs.aws.amazon.com/vpc/latest/userguide/VPC_SecurityGroups.html#SecurityGroupRules) for more information.
:::

## Minimal Example

Create a basic HTTP inbound rule:

```ts
import { Vpc, SecurityGroup, SecurityGroupRule } from "alchemy/aws/ec2";

const vpc = await Vpc("main-vpc", {
  cidrBlock: "10.0.0.0/16"
});

const webSg = await SecurityGroup("web-sg", {
  vpc,
  groupName: "web-server-sg",
  description: "Security group for web servers"
});

const httpRule = await SecurityGroupRule("web-http-rule", {
  securityGroup: webSg,
  type: "ingress",
  protocol: "tcp",
  fromPort: 80,
  toPort: 80,
  cidrBlocks: ["0.0.0.0/0"],
  description: "Allow HTTP traffic from anywhere"
});
```

## HTTPS Rule

Allow HTTPS traffic from the internet:

```ts
import { SecurityGroup, SecurityGroupRule } from "alchemy/aws/ec2";

const httpsRule = await SecurityGroupRule("web-https-rule", {
  securityGroup: webSecurityGroup,
  type: "ingress",
  protocol: "tcp", 
  fromPort: 443,
  toPort: 443,
  cidrBlocks: ["0.0.0.0/0"],
  description: "Allow HTTPS traffic from anywhere"
});
```

## SSH Access Rule

Allow SSH access from specific IP ranges:

```ts
import { SecurityGroup, SecurityGroupRule } from "alchemy/aws/ec2";

const sshRule = await SecurityGroupRule("admin-ssh-rule", {
  securityGroup: adminSecurityGroup,
  type: "ingress",
  protocol: "tcp",
  fromPort: 22,
  toPort: 22,
  cidrBlocks: [
    "203.0.113.0/24",  // Office network
    "198.51.100.0/24"  // VPN network
  ],
  description: "Allow SSH access from office and VPN networks"
});
```

## Database Access Rules

Allow database access from application servers:

```ts
import { SecurityGroup, SecurityGroupRule } from "alchemy/aws/ec2";

// MySQL/MariaDB access rule
const mysqlRule = await SecurityGroupRule("db-mysql-rule", {
  securityGroup: databaseSecurityGroup,
  type: "ingress",
  protocol: "tcp",
  fromPort: 3306,
  toPort: 3306,
  sourceSecurityGroups: [appSecurityGroup],
  description: "Allow MySQL access from application servers"
});

// PostgreSQL access rule  
const postgresRule = await SecurityGroupRule("db-postgres-rule", {
  securityGroup: databaseSecurityGroup,
  type: "ingress",
  protocol: "tcp",
  fromPort: 5432,
  toPort: 5432,
  sourceSecurityGroups: [appSecurityGroup],
  description: "Allow PostgreSQL access from application servers"
});

// Redis access rule
const redisRule = await SecurityGroupRule("cache-redis-rule", {
  securityGroup: cacheSecurityGroup,
  type: "ingress", 
  protocol: "tcp",
  fromPort: 6379,
  toPort: 6379,
  sourceSecurityGroups: [appSecurityGroup],
  description: "Allow Redis access from application servers"
});
```

## Load Balancer Rules

Security group rules for Application Load Balancer setup:

```ts
import { SecurityGroup, SecurityGroupRule } from "alchemy/aws/ec2";

// ALB HTTP rule
const albHttpRule = await SecurityGroupRule("alb-http-rule", {
  securityGroup: albSecurityGroup,
  type: "ingress",
  protocol: "tcp",
  fromPort: 80,
  toPort: 80,
  cidrBlocks: ["0.0.0.0/0"],
  description: "Allow HTTP traffic to ALB from internet"
});

// ALB HTTPS rule
const albHttpsRule = await SecurityGroupRule("alb-https-rule", {
  securityGroup: albSecurityGroup,
  type: "ingress",
  protocol: "tcp",
  fromPort: 443,
  toPort: 443,
  cidrBlocks: ["0.0.0.0/0"],
  description: "Allow HTTPS traffic to ALB from internet"
});

// Web servers receiving traffic from ALB
const webFromAlbRule = await SecurityGroupRule("web-from-alb-rule", {
  securityGroup: webSecurityGroup,
  type: "ingress",
  protocol: "tcp",
  fromPort: 8080,  // Application port
  toPort: 8080,
  sourceSecurityGroups: [albSecurityGroup],
  description: "Allow traffic from ALB to web servers"
});
```

## Egress Rules

Control outbound traffic from instances:

```ts
import { SecurityGroup, SecurityGroupRule } from "alchemy/aws/ec2";

// Allow HTTPS outbound for package updates
const httpsEgressRule = await SecurityGroupRule("web-https-egress", {
  securityGroup: webSecurityGroup,
  type: "egress",
  protocol: "tcp",
  fromPort: 443,
  toPort: 443,
  cidrBlocks: ["0.0.0.0/0"],
  description: "Allow HTTPS outbound for package updates"
});

// Allow HTTP outbound 
const httpEgressRule = await SecurityGroupRule("web-http-egress", {
  securityGroup: webSecurityGroup,
  type: "egress",
  protocol: "tcp",
  fromPort: 80,
  toPort: 80,
  cidrBlocks: ["0.0.0.0/0"],
  description: "Allow HTTP outbound"
});

// Allow DNS resolution
const dnsEgressRule = await SecurityGroupRule("web-dns-egress", {
  securityGroup: webSecurityGroup,
  type: "egress",
  protocol: "udp",
  fromPort: 53,
  toPort: 53,
  cidrBlocks: ["0.0.0.0/0"],
  description: "Allow DNS resolution"
});
```

## Port Range Rules

Allow traffic on a range of ports:

```ts
import { SecurityGroup, SecurityGroupRule } from "alchemy/aws/ec2";

// Allow ephemeral ports for return traffic
const ephemeralRule = await SecurityGroupRule("ephemeral-ports-rule", {
  securityGroup: natSecurityGroup,
  type: "ingress",
  protocol: "tcp",
  fromPort: 1024,
  toPort: 65535,
  cidrBlocks: ["10.0.0.0/16"],  // Only from VPC
  description: "Allow ephemeral ports for return traffic"
});

// Custom application port range
const appPortsRule = await SecurityGroupRule("app-ports-rule", {
  securityGroup: appSecurityGroup,
  type: "ingress",
  protocol: "tcp",
  fromPort: 8000,
  toPort: 8999,
  sourceSecurityGroups: [webSecurityGroup],
  description: "Allow application ports from web tier"
});
```

## ICMP Rules

Allow ping and other ICMP traffic:

```ts
import { SecurityGroup, SecurityGroupRule } from "alchemy/aws/ec2";

// Allow ping from VPC
const pingRule = await SecurityGroupRule("allow-ping-rule", {
  securityGroup: adminSecurityGroup,
  type: "ingress",
  protocol: "icmp",
  fromPort: -1,  // -1 indicates all ICMP types
  toPort: -1,    // -1 indicates all ICMP codes
  cidrBlocks: ["10.0.0.0/16"],
  description: "Allow ping from VPC"
});

// Allow specific ICMP type (echo request)
const echoRule = await SecurityGroupRule("icmp-echo-rule", {
  securityGroup: webSecurityGroup,
  type: "ingress",
  protocol: "icmp",
  fromPort: 8,   // Echo request type
  toPort: -1,    // All codes for this type
  cidrBlocks: ["0.0.0.0/0"],
  description: "Allow ping from anywhere"
});
```

## All Traffic Rules

Allow all traffic (use with caution):

```ts
import { SecurityGroup, SecurityGroupRule } from "alchemy/aws/ec2";

// Allow all traffic between security groups (common pattern)
const allTrafficRule = await SecurityGroupRule("internal-all-traffic", {
  securityGroup: appSecurityGroup,
  type: "ingress", 
  protocol: "-1",  // All protocols
  fromPort: -1,
  toPort: -1,
  sourceSecurityGroups: [webSecurityGroup, dbSecurityGroup],
  description: "Allow all traffic from trusted security groups"
});

// Development environment - allow all outbound
const devEgressRule = await SecurityGroupRule("dev-all-egress", {
  securityGroup: devSecurityGroup,
  type: "egress",
  protocol: "-1",
  fromPort: -1,
  toPort: -1,
  cidrBlocks: ["0.0.0.0/0"],
  description: "Development - allow all outbound traffic"
});
```

## Multi-Source Rule

Allow access from multiple sources:

```ts
import { SecurityGroup, SecurityGroupRule } from "alchemy/aws/ec2";

const multiSourceRule = await SecurityGroupRule("db-multi-access", {
  securityGroup: databaseSecurityGroup,
  type: "ingress",
  protocol: "tcp",
  fromPort: 5432,
  toPort: 5432,
  sourceSecurityGroups: [
    webSecurityGroup,
    appSecurityGroup,
    adminSecurityGroup
  ],
  cidrBlocks: [
    "10.0.0.0/16"  // Also allow from VPC CIDR
  ],
  description: "Allow database access from multiple sources"
});
```

## Custom Protocols

Rules for custom protocols by number:

```ts
import { SecurityGroup, SecurityGroupRule } from "alchemy/aws/ec2";

// GRE protocol (protocol 47)
const greRule = await SecurityGroupRule("vpn-gre-rule", {
  securityGroup: vpnSecurityGroup,
  type: "ingress",
  protocol: "47",  // GRE protocol number
  fromPort: -1,
  toPort: -1,
  cidrBlocks: ["203.0.113.0/24"],
  description: "Allow GRE for VPN tunnel"
});

// ESP protocol (protocol 50) for IPSec
const espRule = await SecurityGroupRule("vpn-esp-rule", {
  securityGroup: vpnSecurityGroup,
  type: "ingress",
  protocol: "50",  // ESP protocol number
  fromPort: -1,
  toPort: -1,
  cidrBlocks: ["203.0.113.0/24"],
  description: "Allow ESP for IPSec VPN"
});
```

## Reference by Security Group ID

Create rules using security group IDs:

```ts
import { SecurityGroupRule } from "alchemy/aws/ec2";

const existingSgRule = await SecurityGroupRule("existing-sg-rule", {
  securityGroup: "sg-1234567890abcdef0",
  type: "ingress",
  protocol: "tcp",
  fromPort: 80,
  toPort: 80,
  cidrBlocks: ["0.0.0.0/0"],
  description: "HTTP rule for existing security group"
});
```

## Microservices Communication

Rules for microservice-to-microservice communication:

```ts
import { SecurityGroup, SecurityGroupRule } from "alchemy/aws/ec2";

// API Gateway to User Service
const apiToUserRule = await SecurityGroupRule("api-to-user-rule", {
  securityGroup: userServiceSg,
  type: "ingress",
  protocol: "tcp",
  fromPort: 3001,
  toPort: 3001,
  sourceSecurityGroups: [apiGatewaySg],
  description: "API Gateway to User Service"
});

// User Service to Order Service
const userToOrderRule = await SecurityGroupRule("user-to-order-rule", {
  securityGroup: orderServiceSg,
  type: "ingress",
  protocol: "tcp",
  fromPort: 3002,
  toPort: 3002,
  sourceSecurityGroups: [userServiceSg],
  description: "User Service to Order Service"
});

// Services to shared database
const servicesToDbRule = await SecurityGroupRule("services-to-db-rule", {
  securityGroup: sharedDbSg,
  type: "ingress",
  protocol: "tcp",
  fromPort: 5432,
  toPort: 5432,
  sourceSecurityGroups: [
    userServiceSg,
    orderServiceSg,
    paymentServiceSg
  ],
  description: "Allow database access from microservices"
});
```

## Reference

Access security group rule properties after creation:

```ts
const rule = await SecurityGroupRule("my-rule", {
  securityGroup: securityGroup,
  type: "ingress",
  protocol: "tcp",
  fromPort: 80,
  toPort: 80,
  cidrBlocks: ["0.0.0.0/0"]
});

console.log(`Rule ID: ${rule.ruleId}`);
console.log(`Security Group: ${rule.securityGroup}`);
console.log(`Type: ${rule.type}`);
console.log(`Protocol: ${rule.protocol}`);
console.log(`Port Range: ${rule.fromPort}-${rule.toPort}`);
```

:::tip
Create security group rules separately from security groups for better control, easier updates, and clearer dependency management.
:::

:::note
Security groups are stateful - if you allow inbound traffic, the corresponding outbound response traffic is automatically allowed.
:::

:::caution
Be careful with rules that allow traffic from "0.0.0.0/0" (anywhere on the internet). Only use for services that genuinely need to be publicly accessible.
::: 