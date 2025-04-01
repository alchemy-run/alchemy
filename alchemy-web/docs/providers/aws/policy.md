# Policy

The Policy component allows you to create and manage [AWS IAM Policies](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies.html) that define permissions for AWS services and resources. It supports automatic versioning and updates when policy content changes.

# Minimal Example

```ts
import { Policy } from "alchemy/aws";

const s3Policy = await Policy("bucket-access", {
  policyName: "s3-bucket-access",
  document: {
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Action: [
        "s3:GetObject",
        "s3:PutObject"
      ],
      Resource: "arn:aws:s3:::my-bucket/*"
    }]
  }
});
```

# Create the Policy

```ts
import { Policy } from "alchemy/aws";

const apiPolicy = await Policy("api-access", {
  policyName: "api-gateway-access",
  document: {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "InvokeAPI",
        Effect: "Allow",
        Action: "execute-api:Invoke",
        Resource: "arn:aws:execute-api:region:account-id:api-id/stage/METHOD/resource-path",
        Condition: {
          StringEquals: {
            "aws:SourceVpc": "vpc-id"
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
        Resource: "arn:aws:logs:region:account-id:log-group:log-group-name:*"
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