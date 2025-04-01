# Role

The Role component allows you to create and manage [AWS IAM Roles](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles.html) with support for inline policies, managed policies, and automatic cleanup of attached policies during deletion.

# Minimal Example

```ts
import { Role } from "alchemy/aws";

const basicRole = await Role("lambda-role", {
  roleName: "lambda-role",
  assumeRolePolicy: {
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Principal: {
        Service: "lambda.amazonaws.com"
      },
      Action: "sts:AssumeRole"
    }]
  }
});
```

# Create the Role

```ts
import { Role } from "alchemy/aws";

// Create a basic Lambda execution role with inline policy
const basicRole = await Role("lambda-role", {
  roleName: "lambda-role",
  assumeRolePolicy: {
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Principal: {
        Service: "lambda.amazonaws.com"
      },
      Action: "sts:AssumeRole"
    }]
  },
  description: "Basic Lambda execution role",
  tags: {
    Environment: "production"
  },
  policies: [{
    policyName: "logs",
    policyDocument: {
      Version: "2012-10-17",
      Statement: [{
        Effect: "Allow",
        Action: [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ],
        Resource: "*"
      }]
    }
  }]
});
```

This example demonstrates creating a basic IAM role for AWS Lambda with an inline policy for logging. The role is tagged for the production environment.