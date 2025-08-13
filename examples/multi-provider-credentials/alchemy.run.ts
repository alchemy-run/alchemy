/**
 * Multi-Provider Scope Credentials Example
 *
 * This example demonstrates how to use the extensible scope credential system
 * to configure multiple cloud providers at the scope level.
 */

import { alchemy } from "alchemy";
import { Vpc } from "alchemy/aws/ec2";
import { Worker } from "alchemy/cloudflare/worker";

/**
 * Example showing how multiple providers can be configured at the scope level
 */
async function deploy() {
  console.log(
    "Starting multi-provider deployment with scope-level credentials...",
  );

  // Deploy resources with both AWS and Cloudflare credentials configured at scope level
  await alchemy.run(
    "multi-provider",
    {
      // AWS credentials for this scope
      aws: {
        region: "us-west-2",
        profile: "test9-374080338393",
      },
      // Cloudflare credentials for this scope
      cloudflare: {
        accountId: "your-cloudflare-account-id",
        // apiToken would typically come from environment or secrets
      },
    },
    async () => {
      console.log("Creating AWS resources with scope-level credentials...");

      // This VPC will use the AWS credentials from the scope
      const vpc = await Vpc("main-vpc", {
        cidrBlock: "10.0.0.0/16",
        tags: {
          Name: "main-vpc",
          Environment: "multi-provider-example",
        },
      });

      // This VPC overrides the region from scope-level credentials
      const euVpc = await Vpc("eu-vpc", {
        cidrBlock: "10.1.0.0/16",
        region: "eu-west-1", // Override scope region
        tags: {
          Name: "eu-vpc",
          Environment: "multi-provider-example",
        },
      });

      console.log(
        "Creating Cloudflare resources with scope-level credentials...",
      );

      // This Worker will use the Cloudflare credentials from the scope
      const worker = await Worker("api-worker", {
        entrypoint: "./worker.ts",
        // Cloudflare credentials come from scope
      });

      console.log("Resources created successfully!");
      console.log(`VPC ID: ${vpc.vpcId}`);
      console.log(`EU VPC ID: ${euVpc.vpcId}`);
      console.log(`Worker ID: ${worker.id}`);
    },
  );

  console.log("Multi-provider deployment completed!");
}

// Example worker code (would be in a separate file)
const _workerCode = `
export default {
  async fetch(request) {
    return new Response("Hello from Cloudflare Worker!");
  }
};
`;

// Run the deployment
deploy().catch((error) => {
  console.error("Deployment failed:", error);
  process.exit(1);
});
