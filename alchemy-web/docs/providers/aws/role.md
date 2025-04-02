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

// Create a role with AWS managed policies
const managedRole = await Role("readonly-role", {
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
  description: "Role with managed policies",
  managedPolicyArns: [
    "arn:aws:iam::aws:policy/ReadOnlyAccess"
  ],
  tags: {
    Environment: "production"
  }
});

// Create a role with multiple inline policies and custom session duration
const customRole = await Role("custom-role", {
  roleName: "custom-role",
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
  description: "Role with multiple policies",
  maxSessionDuration: 7200,
  policies: [
    {
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
    },
    {
      policyName: "s3",
      policyDocument: {
        Version: "2012-10-17",
        Statement: [{
          Effect: "Allow",
          Action: "s3:ListBucket",
          Resource: "*"
        }]
      }
    }
  ],
  tags: {
    Environment: "production",
    Updated: "true"
  }
});
```