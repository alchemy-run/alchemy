# Policy

The Policy Resource creates and manages [AWS IAM Policies](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies.html) that define permissions for AWS services and resources.

# Minimal Example

Create a basic IAM policy that allows S3 bucket access.

```ts
import { Policy } from "alchemy/aws";

const policy = await Policy("bucket-access", {
  policyName: "s3-bucket-access", 
  document: {
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Action: [
        "s3:GetObject",
        "s3:PutObject"
      ],
      Resource: `${bucket.arn}/*`
    }]
  }
});
```

# Create a Policy with Multiple Statements

```ts
import { Policy } from "alchemy/aws";

const policy = await Policy("api-access", {
  policyName: "api-gateway-access",
  document: {
    Version: "2012-10-17", 
    Statement: [
      {
        Sid: "InvokeAPI",
        Effect: "Allow",
        Action: "execute-api:Invoke",
        Resource: `${api.executionArn}/*`,
        Condition: {
          StringEquals: {
            "aws:SourceVpc": vpc.id
          }
        }
      },
      {
        Sid: "ReadLogs",
        Effect: "Allow", 
        Action: [
          "logs:GetLogEvents",
          "logs:FilterLogEvents"
        ],
        Resource: `${api.logGroupArn}:*`
      }
    ]
  },
  description: "Allows invoking API Gateway endpoints and reading logs",
  tags: {
    Service: "API Gateway",
    Environment: "production"
  }
});
```

# Create a Deny Policy

```ts
import { Policy } from "alchemy/aws";

const policy = await Policy("deny-production", {
  policyName: "deny-production-access",
  document: {
    Version: "2012-10-17",
    Statement: [{
      Effect: "Deny",
      Action: "*", 
      Resource: "*",
      Condition: {
        StringEquals: {
          "aws:ResourceTag/Environment": "production"
        }
      }
    }]
  }
});
```