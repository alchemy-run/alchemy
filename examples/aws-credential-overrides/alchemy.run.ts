/**
 * Multi-Account AWS Deployment Example
 *
 * This example demonstrates how to deploy resources to multiple AWS accounts
 * and regions in a single Alchemy deployment.
 */

import { alchemy } from "alchemy";
import {
  InternetGateway,
  InternetGatewayAttachment,
  Route,
  RouteTable,
  SecurityGroup,
  Subnet,
  Vpc,
} from "alchemy/aws/ec2";

/**
 * Main deployment function that creates resources across multiple AWS accounts
 */
async function deploy() {
  console.log("Starting multi-account deployment...");

  // Set global default AWS settings
  // These will be used if no other credentials are specified
  process.env.AWS_REGION = "us-west-2";

  // Deploy to production account
  await alchemy.run(
    "production",
    {
      // Scope-level AWS credential overrides
      aws: {
        region: "us-west-2",
        profile: "production-account", // Replace with your production profile
      },
    },
    async () => {
      console.log("Deploying production resources...");

      // Create production VPC and related resources
      const prodVpc = await Vpc("production-vpc", {
        cidrBlock: "10.0.0.0/16",
        enableDnsSupport: true,
        enableDnsHostnames: true,
        tags: {
          Name: "production-vpc",
          Environment: "production",
        },
      });

      // Create production subnet
      const _prodSubnet = await Subnet("production-subnet", {
        vpc: prodVpc,
        cidrBlock: "10.0.1.0/24",
        availabilityZone: "us-west-2a",
        mapPublicIpOnLaunch: true,
        tags: {
          Name: "production-subnet",
          Environment: "production",
        },
      });

      // Create Internet Gateway for production VPC
      const prodIgw = await InternetGateway("production-igw", {
        tags: {
          Name: "production-igw",
          Environment: "production",
        },
      });

      // Attach Internet Gateway to production VPC
      await InternetGatewayAttachment("production-igw-attachment", {
        internetGateway: prodIgw,
        vpc: prodVpc,
      });

      // Create production security group
      const _prodSg = await SecurityGroup("production-web-sg", {
        vpc: prodVpc,
        description: "Production web security group",
        ingressRules: [
          {
            protocol: "tcp",
            fromPort: 80,
            toPort: 80,
            cidrBlocks: ["0.0.0.0/0"],
          },
          {
            protocol: "tcp",
            fromPort: 443,
            toPort: 443,
            cidrBlocks: ["0.0.0.0/0"],
          },
        ],
        tags: {
          Name: "production-web-sg",
          Environment: "production",
        },
      });

      // Create route table for production VPC
      const prodRouteTable = await RouteTable("production-rt", {
        vpc: prodVpc,
        tags: {
          Name: "production-rt",
          Environment: "production",
        },
      });

      // Add default route to Internet Gateway
      await Route("production-default-route", {
        routeTable: prodRouteTable,
        destinationCidrBlock: "0.0.0.0/0",
        target: { internetGateway: prodIgw },
      });

      // Create a resource in the staging account from within the production scope
      // This demonstrates cross-account deployment within a scope
      const stagingVpc = await Vpc("staging-vpc-from-prod", {
        cidrBlock: "10.1.0.0/16",
        profile: "staging-account", // Override to use staging account
        region: "us-east-1", // Override to use a different region
        tags: {
          Name: "staging-vpc-from-prod",
          Environment: "staging",
          DeployedFrom: "production-scope",
        },
      });

      // Create security group in staging VPC
      await SecurityGroup("staging-sg-from-prod", {
        vpc: stagingVpc,
        profile: "staging-account", // Must specify the same account as the VPC
        region: "us-east-1", // Must specify the same region as the VPC
        description: "Staging security group deployed from production scope",
        ingressRules: [
          {
            protocol: "tcp",
            fromPort: 22,
            toPort: 22,
            cidrBlocks: ["10.0.0.0/8"],
          },
        ],
        tags: {
          Name: "staging-sg-from-prod",
          Environment: "staging",
          DeployedFrom: "production-scope",
        },
      });
    },
  );

  // Deploy to staging account
  await alchemy.run(
    "staging",
    {
      // Scope-level AWS credential overrides
      aws: {
        region: "us-east-1",
        profile: "staging-account", // Replace with your staging profile
      },
    },
    async () => {
      console.log("Deploying staging resources...");

      // Create staging VPC
      const stagingVpc = await Vpc("staging-vpc", {
        cidrBlock: "10.2.0.0/16",
        enableDnsSupport: true,
        enableDnsHostnames: true,
        tags: {
          Name: "staging-vpc",
          Environment: "staging",
        },
      });

      // Create staging subnet
      const _stagingSubnet = await Subnet("staging-subnet", {
        vpc: stagingVpc,
        cidrBlock: "10.2.1.0/24",
        availabilityZone: "us-east-1a",
        mapPublicIpOnLaunch: true,
        tags: {
          Name: "staging-subnet",
          Environment: "staging",
        },
      });

      // Create Internet Gateway for staging VPC
      const stagingIgw = await InternetGateway("staging-igw", {
        tags: {
          Name: "staging-igw",
          Environment: "staging",
        },
      });

      // Attach Internet Gateway to staging VPC
      await InternetGatewayAttachment("staging-igw-attachment", {
        internetGateway: stagingIgw,
        vpc: stagingVpc,
      });

      // Create staging security group
      await SecurityGroup("staging-web-sg", {
        vpc: stagingVpc,
        description: "Staging web security group",
        ingressRules: [
          {
            protocol: "tcp",
            fromPort: 80,
            toPort: 80,
            cidrBlocks: ["0.0.0.0/0"],
          },
        ],
        tags: {
          Name: "staging-web-sg",
          Environment: "staging",
        },
      });

      // Create a resource in the development account from within the staging scope
      // This demonstrates cross-account deployment with role assumption
      const _devVpc = await Vpc("dev-vpc-from-staging", {
        cidrBlock: "10.3.0.0/16",
        roleArn: "arn:aws:iam::123456789012:role/DevAccountAccess", // Replace with your role ARN
        roleSessionName: "alchemy-cross-account-deployment",
        region: "us-west-2",
        tags: {
          Name: "dev-vpc-from-staging",
          Environment: "development",
          DeployedFrom: "staging-scope",
        },
      });
    },
  );

  console.log("Multi-account deployment completed successfully!");
}

// Run the deployment
deploy().catch((error) => {
  console.error("Deployment failed:", error);
  process.exit(1);
});
