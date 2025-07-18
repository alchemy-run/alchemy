# AWS Credential Overrides Example

This example demonstrates how to deploy AWS resources to multiple accounts and regions in a single Alchemy deployment.

## Overview

The example creates infrastructure across different AWS accounts:

- **Production Account**: VPC, Internet Gateway, Security Group, and Route Table in `us-west-2`
- **Staging Account**: VPC, Internet Gateway, and Security Group in `us-east-1`
- **Development Account**: VPC in `us-west-2` using role assumption

It also demonstrates cross-account deployments, where resources in one account are created from a scope configured for another account.

## Prerequisites

Before running this example, you need:

1. AWS credentials for multiple accounts configured in your AWS credentials file
2. Appropriate IAM permissions in each account
3. For the role assumption example, a properly configured IAM role that can be assumed

## Configuration

Update the following values in `alchemy.run.ts` to match your environment:

- AWS profile names (`production-account`, `staging-account`)
- AWS regions (`us-west-2`, `us-east-1`)
- Role ARN for cross-account access (`arn:aws:iam::123456789012:role/DevAccountAccess`)
- CIDR blocks for VPCs if needed

## Running the Example

```bash
# Make sure you're in the project root directory
cd examples/aws-credential-overrides

# Run the example
bun run alchemy.run.ts
```

## Key Concepts Demonstrated

1. **Global AWS Settings**: Setting default AWS configuration for the entire application

   ```typescript
   alchemy.aws = {
     region: "us-west-2",
   };
   ```

2. **Scope-Level Credentials**: Setting AWS credentials for a specific deployment scope

   ```typescript
   await alchemy.run("production", {
     aws: {
       profile: "production-account",
       region: "us-west-2",
     },
   }, async () => {
     // Resources created here use production-account credentials by default
   });
   ```

3. **Resource-Level Credential Overrides**: Overriding credentials for specific resources

   ```typescript
   const stagingVpc = await Vpc("staging-vpc-from-prod", {
     cidrBlock: "10.1.0.0/16",
     profile: "staging-account", // Override to use staging account
     region: "us-east-1",        // Override to use a different region
     tags: { /* ... */ },
   });
   ```

4. **Role Assumption**: Assuming an IAM role in another account

   ```typescript
   const devVpc = await Vpc("dev-vpc-from-staging", {
     cidrBlock: "10.3.0.0/16",
     roleArn: "arn:aws:iam::123456789012:role/DevAccountAccess",
     roleSessionName: "alchemy-cross-account-deployment",
     region: "us-west-2",
     tags: { /* ... */ },
   });
   ```

## Notes

- This example creates real AWS resources that may incur costs
- Remember to destroy resources when you're done testing
- The example doesn't include error handling for credential issues