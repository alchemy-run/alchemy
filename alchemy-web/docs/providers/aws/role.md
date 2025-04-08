# Role

The Role component lets you create and manage [AWS IAM Roles](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles.html) that define permissions for AWS services and resources.

# Minimal Example

Create a basic Lambda execution role with permissions to write logs.

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

# Create Role with Managed Policies

Create a role that uses AWS managed policies for common permissions.

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
    "arn:aws:iam::aws:policy/ReadOnlyAccess",
    "arn:aws:iam::aws:policy/AWSLambdaBasicExecutionRole"
  ],
  tags: {
    Environment: "production"
  }
});
```