---
title: NatGateway
description: Create and manage AWS NAT Gateways to provide outbound internet access for private subnets.
---

An [AWS NAT Gateway](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-nat-gateway.html) enables instances in private subnets to connect to the internet or other AWS services while preventing the internet from initiating connections to those instances. NAT Gateways are managed by AWS and provide high availability within an Availability Zone.

:::note
See AWS's official [NAT Gateway documentation](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-nat-gateway.html) for more information.
:::

## Minimal Example

Create a basic NAT Gateway in a public subnet:

```ts
import { Vpc, Subnet, NatGateway } from "alchemy/aws/ec2";

const vpc = await Vpc("main-vpc", {
  cidrBlock: "10.0.0.0/16"
});

const publicSubnet = await Subnet("public-subnet", {
  vpc: vpc,
  cidrBlock: "10.0.1.0/24",
  availabilityZone: "us-east-1a",
  mapPublicIpOnLaunch: true
});

const natGateway = await NatGateway("main-nat", {
  subnet: publicSubnet
});
```

## NAT Gateway with Custom Elastic IP

Use an existing Elastic IP allocation:

```ts
import { Vpc, Subnet, NatGateway } from "alchemy/aws/ec2";

const vpc = await Vpc("web-vpc", {
  cidrBlock: "10.0.0.0/16"
});

const publicSubnet = await Subnet("public-subnet", {
  vpc: vpc,
  cidrBlock: "10.0.1.0/24",
  availabilityZone: "us-east-1a",
  mapPublicIpOnLaunch: true
});

const natGateway = await NatGateway("web-nat", {
  subnet: publicSubnet,
  allocationId: "eipalloc-1234567890abcdef0",  // Existing EIP
  tags: {
    Name: "web-nat-gateway",
    Environment: "production"
  }
});
```

## Private NAT Gateway

Create a private NAT Gateway for VPC-to-VPC communication:

```ts
import { Vpc, Subnet, NatGateway } from "alchemy/aws/ec2";

const vpc = await Vpc("private-vpc", {
  cidrBlock: "10.0.0.0/16"
});

const privateSubnet = await Subnet("nat-subnet", {
  vpc: vpc,
  cidrBlock: "10.0.1.0/24",
  availabilityZone: "us-east-1a"
});

const privateNatGateway = await NatGateway("private-nat", {
  subnet: privateSubnet,
  connectivityType: "private",
  tags: {
    Name: "private-nat-gateway",
    Type: "private",
    Purpose: "vpc-to-vpc-communication"
  }
});
```

## Multi-AZ NAT Gateway Setup

Create NAT Gateways in multiple Availability Zones for high availability:

```ts
import { 
  Vpc,
  Subnet,
  InternetGateway,
  InternetGatewayAttachment,
  NatGateway,
  RouteTable,
  Route,
  RouteTableAssociation
} from "alchemy/aws/ec2";

const vpc = await Vpc("ha-vpc", {
  cidrBlock: "10.0.0.0/16",
  enableDnsHostnames: true,
  enableDnsSupport: true,
  tags: {
    Name: "high-availability-vpc"
  }
});

// Internet Gateway
const igw = await InternetGateway("ha-igw", {
  tags: { Name: "ha-internet-gateway" }
});

const igwAttachment = await InternetGatewayAttachment("ha-igw-attachment", {
  internetGateway: igw,
  vpc: vpc
});

// Public subnets for NAT Gateways
const publicSubnet1a = await Subnet("public-subnet-1a", {
  vpc: vpc,
  cidrBlock: "10.0.1.0/24",
  availabilityZone: "us-east-1a",
  mapPublicIpOnLaunch: true,
  tags: { Name: "public-subnet-1a", Type: "public" }
});

const publicSubnet1b = await Subnet("public-subnet-1b", {
  vpc: vpc,
  cidrBlock: "10.0.2.0/24",
  availabilityZone: "us-east-1b",
  mapPublicIpOnLaunch: true,
  tags: { Name: "public-subnet-1b", Type: "public" }
});

const publicSubnet1c = await Subnet("public-subnet-1c", {
  vpc: vpc,
  cidrBlock: "10.0.3.0/24",
  availabilityZone: "us-east-1c",
  mapPublicIpOnLaunch: true,
  tags: { Name: "public-subnet-1c", Type: "public" }
});

// Private subnets
const privateSubnet1a = await Subnet("private-subnet-1a", {
  vpc: vpc,
  cidrBlock: "10.0.11.0/24",
  availabilityZone: "us-east-1a",
  tags: { Name: "private-subnet-1a", Type: "private" }
});

const privateSubnet1b = await Subnet("private-subnet-1b", {
  vpc: vpc,
  cidrBlock: "10.0.12.0/24",
  availabilityZone: "us-east-1b",
  tags: { Name: "private-subnet-1b", Type: "private" }
});

const privateSubnet1c = await Subnet("private-subnet-1c", {
  vpc: vpc,
  cidrBlock: "10.0.13.0/24",
  availabilityZone: "us-east-1c",
  tags: { Name: "private-subnet-1c", Type: "private" }
});

// NAT Gateways in each AZ
const natGateway1a = await NatGateway("nat-gateway-1a", {
  subnet: publicSubnet1a,
  tags: {
    Name: "nat-gateway-1a",
    AvailabilityZone: "us-east-1a"
  }
});

const natGateway1b = await NatGateway("nat-gateway-1b", {
  subnet: publicSubnet1b,
  tags: {
    Name: "nat-gateway-1b",
    AvailabilityZone: "us-east-1b"
  }
});

const natGateway1c = await NatGateway("nat-gateway-1c", {
  subnet: publicSubnet1c,
  tags: {
    Name: "nat-gateway-1c",
    AvailabilityZone: "us-east-1c"
  }
});

// Public route table (shared)
const publicRouteTable = await RouteTable("public-rt", {
  vpc: vpc,
  tags: { Name: "public-route-table" }
});

const publicInternetRoute = await Route("public-internet-route", {
  routeTable: publicRouteTable,
  destinationCidrBlock: "0.0.0.0/0",
  target: { internetGateway: igw }
});

// Private route tables (one per AZ)
const privateRouteTable1a = await RouteTable("private-rt-1a", {
  vpc: vpc,
  tags: { Name: "private-route-table-1a", AvailabilityZone: "us-east-1a" }
});

const privateRouteTable1b = await RouteTable("private-rt-1b", {
  vpc: vpc,
  tags: { Name: "private-route-table-1b", AvailabilityZone: "us-east-1b" }
});

const privateRouteTable1c = await RouteTable("private-rt-1c", {
  vpc: vpc,
  tags: { Name: "private-route-table-1c", AvailabilityZone: "us-east-1c" }
});

// NAT routes
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

const natRoute1c = await Route("nat-route-1c", {
  routeTable: privateRouteTable1c,
  destinationCidrBlock: "0.0.0.0/0",
  target: { natGateway: natGateway1c }
});

// Route table associations
const publicAssociation1a = await RouteTableAssociation("public-association-1a", {
  routeTable: publicRouteTable,
  subnet: publicSubnet1a
});

const publicAssociation1b = await RouteTableAssociation("public-association-1b", {
  routeTable: publicRouteTable,
  subnet: publicSubnet1b
});

const publicAssociation1c = await RouteTableAssociation("public-association-1c", {
  routeTable: publicRouteTable,
  subnet: publicSubnet1c
});

const privateAssociation1a = await RouteTableAssociation("private-association-1a", {
  routeTable: privateRouteTable1a,
  subnet: privateSubnet1a
});

const privateAssociation1b = await RouteTableAssociation("private-association-1b", {
  routeTable: privateRouteTable1b,
  subnet: privateSubnet1b
});

const privateAssociation1c = await RouteTableAssociation("private-association-1c", {
  routeTable: privateRouteTable1c,
  subnet: privateSubnet1c
});
```

## Cost-Optimized Single NAT Gateway

Single NAT Gateway for development or cost-conscious environments:

```ts
import { 
  Vpc,
  Subnet,
  NatGateway,
  RouteTable,
  Route,
  RouteTableAssociation
} from "alchemy/aws/ec2";

const vpc = await Vpc("dev-vpc", {
  cidrBlock: "10.0.0.0/16"
});

// Single public subnet for NAT Gateway
const publicSubnet = await Subnet("dev-public-subnet", {
  vpc: vpc,
  cidrBlock: "10.0.1.0/24",
  availabilityZone: "us-east-1a",
  mapPublicIpOnLaunch: true,
  tags: { Name: "dev-public-subnet" }
});

// Multiple private subnets
const privateSubnet1a = await Subnet("dev-private-subnet-1a", {
  vpc: vpc,
  cidrBlock: "10.0.11.0/24",
  availabilityZone: "us-east-1a",
  tags: { Name: "dev-private-subnet-1a" }
});

const privateSubnet1b = await Subnet("dev-private-subnet-1b", {
  vpc: vpc,
  cidrBlock: "10.0.12.0/24",
  availabilityZone: "us-east-1b",
  tags: { Name: "dev-private-subnet-1b" }
});

// Single NAT Gateway for cost optimization
const sharedNatGateway = await NatGateway("shared-nat", {
  subnet: publicSubnet,
  tags: {
    Name: "shared-development-nat",
    Environment: "development",
    CostOptimization: "shared-across-azs"
  }
});

// Shared private route table
const sharedPrivateRouteTable = await RouteTable("shared-private-rt", {
  vpc: vpc,
  tags: {
    Name: "shared-private-route-table",
    Environment: "development"
  }
});

const sharedNatRoute = await Route("shared-nat-route", {
  routeTable: sharedPrivateRouteTable,
  destinationCidrBlock: "0.0.0.0/0",
  target: { natGateway: sharedNatGateway }
});

// Associate both private subnets with shared route table
const privateAssociation1a = await RouteTableAssociation("dev-private-association-1a", {
  routeTable: sharedPrivateRouteTable,
  subnet: privateSubnet1a
});

const privateAssociation1b = await RouteTableAssociation("dev-private-association-1b", {
  routeTable: sharedPrivateRouteTable,
  subnet: privateSubnet1b
});
```

## NAT Gateway with Custom Timeout

Configure timeout settings for environments with slower provisioning:

```ts
import { Vpc, Subnet, NatGateway } from "alchemy/aws/ec2";

const vpc = await Vpc("slow-vpc", {
  cidrBlock: "10.0.0.0/16"
});

const publicSubnet = await Subnet("slow-public-subnet", {
  vpc: vpc,
  cidrBlock: "10.0.1.0/24",
  availabilityZone: "us-east-1a",
  mapPublicIpOnLaunch: true
});

const slowNatGateway = await NatGateway("slow-nat", {
  subnet: publicSubnet,
  timeout: {
    maxAttempts: 120,  // NAT Gateways can take up to 10 minutes
    delayMs: 5000      // 5 second delay between checks
  },
  tags: {
    Name: "slow-environment-nat"
  }
});
```

## Reference by Subnet ID

Create NAT Gateway using subnet ID:

```ts
import { NatGateway } from "alchemy/aws/ec2";

const existingSubnetNat = await NatGateway("existing-subnet-nat", {
  subnet: "subnet-1234567890abcdef0",
  tags: {
    Name: "existing-subnet-nat-gateway"
  }
});
```

## Microservices NAT Gateway

NAT Gateway setup for microservices architecture:

```ts
import { 
  Vpc,
  Subnet,
  NatGateway,
  RouteTable,
  Route,
  RouteTableAssociation
} from "alchemy/aws/ec2";

const vpc = await Vpc("microservices-vpc", {
  cidrBlock: "10.0.0.0/16"
});

// Public subnet for NAT Gateway
const natSubnet = await Subnet("nat-subnet", {
  vpc: vpc,
  cidrBlock: "10.0.1.0/24",
  availabilityZone: "us-east-1a",
  mapPublicIpOnLaunch: true,
  tags: {
    Name: "nat-subnet",
    Purpose: "nat-gateway"
  }
});

// Private subnets for microservices
const servicesSubnet1a = await Subnet("services-subnet-1a", {
  vpc: vpc,
  cidrBlock: "10.0.11.0/24",
  availabilityZone: "us-east-1a",
  tags: {
    Name: "microservices-subnet-1a",
    Tier: "microservices"
  }
});

const servicesSubnet1b = await Subnet("services-subnet-1b", {
  vpc: vpc,
  cidrBlock: "10.0.12.0/24",
  availabilityZone: "us-east-1b",
  tags: {
    Name: "microservices-subnet-1b",
    Tier: "microservices"
  }
});

// Shared services subnet
const sharedSubnet = await Subnet("shared-subnet", {
  vpc: vpc,
  cidrBlock: "10.0.21.0/24",
  availabilityZone: "us-east-1a",
  tags: {
    Name: "shared-services-subnet",
    Tier: "shared-services"
  }
});

// NAT Gateway for outbound access
const microservicesNat = await NatGateway("microservices-nat", {
  subnet: natSubnet,
  tags: {
    Name: "microservices-nat-gateway",
    Architecture: "microservices",
    Purpose: "outbound-internet-access"
  }
});

// Route tables and routes
const servicesRouteTable = await RouteTable("services-rt", {
  vpc: vpc,
  tags: { Name: "microservices-route-table" }
});

const sharedRouteTable = await RouteTable("shared-rt", {
  vpc: vpc,
  tags: { Name: "shared-services-route-table" }
});

const servicesNatRoute = await Route("services-nat-route", {
  routeTable: servicesRouteTable,
  destinationCidrBlock: "0.0.0.0/0",
  target: { natGateway: microservicesNat }
});

const sharedNatRoute = await Route("shared-nat-route", {
  routeTable: sharedRouteTable,
  destinationCidrBlock: "0.0.0.0/0",
  target: { natGateway: microservicesNat }
});

// Associations
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

## Database Access Pattern

NAT Gateway for database maintenance and updates:

```ts
import { 
  Vpc,
  Subnet,
  NatGateway,
  RouteTable,
  Route,
  RouteTableAssociation
} from "alchemy/aws/ec2";

const vpc = await Vpc("database-vpc", {
  cidrBlock: "10.0.0.0/16"
});

// Public subnet for NAT Gateway
const natSubnet = await Subnet("db-nat-subnet", {
  vpc: vpc,
  cidrBlock: "10.0.1.0/24",
  availabilityZone: "us-east-1a",
  mapPublicIpOnLaunch: true
});

// Database subnets (normally isolated)
const dbSubnet1a = await Subnet("db-subnet-1a", {
  vpc: vpc,
  cidrBlock: "10.0.11.0/24",
  availabilityZone: "us-east-1a",
  tags: { Name: "database-subnet-1a", Tier: "database" }
});

const dbSubnet1b = await Subnet("db-subnet-1b", {
  vpc: vpc,
  cidrBlock: "10.0.12.0/24",
  availabilityZone: "us-east-1b",
  tags: { Name: "database-subnet-1b", Tier: "database" }
});

// NAT Gateway for database maintenance access
const dbMaintenanceNat = await NatGateway("db-maintenance-nat", {
  subnet: natSubnet,
  tags: {
    Name: "database-maintenance-nat",
    Purpose: "database-updates-patches",
    Usage: "maintenance-only"
  }
});

// Maintenance route table (used temporarily)
const maintenanceRouteTable = await RouteTable("db-maintenance-rt", {
  vpc: vpc,
  tags: {
    Name: "database-maintenance-route-table",
    Purpose: "temporary-internet-access"
  }
});

const maintenanceNatRoute = await Route("maintenance-nat-route", {
  routeTable: maintenanceRouteTable,
  destinationCidrBlock: "0.0.0.0/0",
  target: { natGateway: dbMaintenanceNat }
});

// Normal isolated route table (no internet access)
const isolatedRouteTable = await RouteTable("db-isolated-rt", {
  vpc: vpc,
  tags: {
    Name: "database-isolated-route-table",
    Purpose: "no-internet-access"
  }
});

// Default associations (isolated)
const isolatedAssociation1a = await RouteTableAssociation("db-isolated-association-1a", {
  routeTable: isolatedRouteTable,
  subnet: dbSubnet1a
});

const isolatedAssociation1b = await RouteTableAssociation("db-isolated-association-1b", {
  routeTable: isolatedRouteTable,
  subnet: dbSubnet1b
});
```

## Reference

Access NAT Gateway properties after creation:

```ts
const natGateway = await NatGateway("my-nat", {
  subnet: publicSubnet,
  tags: {
    Name: "my-nat-gateway"
  }
});

console.log(`NAT Gateway ID: ${natGateway.natGatewayId}`);
console.log(`Subnet ID: ${natGateway.subnetId}`);
console.log(`VPC ID: ${natGateway.vpcId}`);
console.log(`State: ${natGateway.state}`);
console.log(`Allocation ID: ${natGateway.allocationId}`);
console.log(`Public IP: ${natGateway.publicIp}`);
console.log(`Private IP: ${natGateway.privateIp}`);
console.log(`Created Elastic IP: ${natGateway.createdElasticIp}`);
```

:::tip
For high availability, create NAT Gateways in multiple Availability Zones with separate route tables for each private subnet.
:::

:::note
NAT Gateways can take 5-10 minutes to become available. The resource includes appropriate timeout settings but you can customize them if needed.
:::

:::caution
NAT Gateways incur hourly charges and data processing charges. For cost optimization in development environments, consider using a single NAT Gateway shared across multiple private subnets.
:::

:::warning
If Alchemy creates an Elastic IP for the NAT Gateway, it will also clean up the Elastic IP when the NAT Gateway is destroyed. If you provide your own `allocationId`, you're responsible for managing that Elastic IP.
::: 