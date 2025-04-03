# Role

The Role component lets you create and manage [AWS IAM Roles](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles.html) with support for inline policies, managed policies, and automatic cleanup of attached policies during deletion.

# Minimal Example

Create a basic Lambda execution role with an inline policy.

```ts
import { Role } from "alchemy/aws";

const role = await Role("lambda-role", {
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

# Create a Role with AWS Managed Policies

```ts
import { Role } from "alchemy/aws";

const role = await Role("readonly-role", {
  roleName: "readonly-role",
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
  managedPolicyArns: [
    "arn:aws:iam::aws:policy/ReadOnlyAccess"
  ],
  tags: {
    Environment: "production"
  }
});
```