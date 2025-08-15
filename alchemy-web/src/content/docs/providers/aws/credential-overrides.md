---
title: AWS Credential Overrides
description: Deploy resources to multiple AWS accounts and regions in a single deployment
---

# AWS Credential Overrides

Alchemy supports deploying resources to multiple AWS accounts and regions in a single deployment. This enables complex multi-account architectures and cross-account resource management from a single codebase.

## Overview

The AWS credential override system in Alchemy provides a flexible three-tier approach to credential management:

1. **Global Level**: Default credentials from environment variables
2. **Scope Level**: Credentials specified in `alchemy.run()` options
3. **Resource Level**: Credentials specified in individual resource properties

This hierarchical approach allows for precise control over which credentials are used for each resource, enabling multi-account deployments where resources can be created in different AWS accounts as needed.

## Credential Properties

The following credential properties can be specified at any level:

| Property | Type | Description | Environment Variable |
|----------|------|-------------|---------------------|
| `region` | string | AWS region (e.g., "us-east-1") | `AWS_REGION`, `AWS_DEFAULT_REGION` |
| `profile` | string | AWS profile name from credentials file | `AWS_PROFILE` |
| `roleArn` | string | ARN of IAM role to assume | `AWS_ROLE_ARN` |
| `roleSessionName` | string | Session name for assumed role | `AWS_ROLE_SESSION_NAME` |
| `accessKeyId` | Secret<string> | AWS access key ID | `AWS_ACCESS_KEY_ID` |
| `secretAccessKey` | Secret<string> | AWS secret access key | `AWS_SECRET_ACCESS_KEY` |
| `sessionToken` | Secret<string> | AWS session token (for temporary credentials) | `AWS_SESSION_TOKEN` |
| `externalId` | string | External ID when assuming a role | `AWS_EXTERNAL_ID` |

## Usage Examples

### Global Level Credentials (Environment Variables)

The simplest way to provide AWS credentials is through environment variables:

```bash
export AWS_REGION=us-west-2
export AWS_PROFILE=production
```

These credentials will be used by default for all AWS resources unless overridden at the scope or resource level.

### Application Level Credentials

You can also specify AWS credentials when creating the main application scope:

```typescript
import { alchemy } from "alchemy";
import { Vpc } from "alchemy/aws/ec2";

const app = await alchemy("my-app", {
  aws: {
    region: "us-west-2",
    profile: "production",
  },
});

// All resources will use the specified credentials by default
const vpc = await Vpc("main-vpc", {
  cidrBlock: "10.0.0.0/16",
  tags: { Name: "main-vpc" }
});
```



### Resource Level Credentials

You can override credentials for specific resources by providing credential properties directly in the resource options:

```typescript
import { Vpc } from "alchemy/aws/ec2";

// Create a VPC in one account
const mainVpc = await Vpc("main-vpc", {
  cidrBlock: "10.0.0.0/16",
  profile: "main-account",
  region: "us-west-2",
  tags: { Name: "main-vpc" }
});

// Create a VPC in another account
const secondaryVpc = await Vpc("secondary-vpc", {
  cidrBlock: "10.1.0.0/16",
  profile: "secondary-account",
  region: "us-east-1",
  tags: { Name: "secondary-vpc" }
});
```

### Using Role Assumption

You can assume an IAM role in another account for cross-account access:

```typescript
import { Vpc } from "alchemy/aws/ec2";

// Create a VPC using role assumption
const vpc = await Vpc("cross-account-vpc", {
  cidrBlock: "10.0.0.0/16",
  roleArn: "arn:aws:iam::123456789012:role/DeploymentRole",
  roleSessionName: "alchemy-deployment",
  region: "us-west-2",
  tags: { Name: "cross-account-vpc" }
});
```

### Using Sensitive Credentials

When providing sensitive credentials like access keys, always use `alchemy.secret()` to ensure they are properly encrypted:

```typescript
import { alchemy } from "alchemy";
import { Vpc } from "alchemy/aws/ec2";

// Resource-level credentials with secrets
const vpc = await Vpc("secure-vpc", {
  cidrBlock: "10.0.0.0/16",
  accessKeyId: alchemy.secret(process.env.AWS_ACCESS_KEY_ID!),
  secretAccessKey: alchemy.secret(process.env.AWS_SECRET_ACCESS_KEY!),
  sessionToken: alchemy.secret(process.env.AWS_SESSION_TOKEN!),
  region: "us-west-2",
  tags: { Name: "secure-vpc" }
});

// Scope-level credentials with secrets
await alchemy.run("production", {
  aws: {
    accessKeyId: alchemy.secret(process.env.PROD_AWS_ACCESS_KEY_ID!),
    secretAccessKey: alchemy.secret(process.env.PROD_AWS_SECRET_ACCESS_KEY!),
    region: "us-west-2"
  }
}, async () => {
  // All AWS resources inherit the encrypted credentials
  const vpc = await Vpc("prod-vpc", {
    cidrBlock: "10.0.0.0/16",
    tags: { Name: "prod-vpc" }
  });
});
```

### Scope Level Credentials

You can specify AWS credentials for a specific scope using the `alchemy.run()` options:

```typescript
import { alchemy } from "alchemy";
import { Vpc } from "alchemy/aws/ec2";

await alchemy.run("production", {
  // Scope-level AWS credential overrides
  aws: {
    region: "us-east-1",
    profile: "production-account",
  },
}, async () => {
  // Resources created here will use the production-account profile
  // and us-east-1 region by default
  const vpc = await Vpc("main-vpc", {
    cidrBlock: "10.0.0.0/16",
    tags: { Name: "main-vpc" }
  });
});
```

## Credential Resolution

When resolving AWS credentials, Alchemy follows this order of precedence:

1. Resource-level credentials (highest priority)
2. Scope-level credentials (from `alchemy.run()` options)
3. Global-level credentials (from environment variables)

## Supported Resources

The following AWS resources support credential overrides:

- VPC
- Subnet
- Internet Gateway
- Internet Gateway Attachment
- Security Group
- NAT Gateway
- Route Table
- Route

## Best Practices

1. **Use profiles instead of hard-coded credentials** whenever possible
2. **Be consistent with regions** within related resources
3. **Use the minimum required permissions** for each account
4. **Document which resources deploy to which accounts** for clarity
5. **Test multi-account deployments** thoroughly before using in production

## Troubleshooting

### Common Issues

- **"Profile not found"**: Ensure the specified profile exists in your AWS credentials file
- **"Access denied"**: Check that the credentials have the necessary permissions
- **"Resource not found"**: Verify you're using the correct region for lookups
- **"Invalid credentials"**: Ensure credentials are correctly formatted and not expired

### Debugging Tips

- Set `AWS_SDK_LOAD_CONFIG=1` to ensure the SDK loads config from the AWS config file
- Use `AWS_PROFILE` environment variable to set a default profile for testing
- Check AWS CloudTrail logs to see which credentials were used for API calls