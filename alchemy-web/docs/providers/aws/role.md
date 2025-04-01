# Role

The Role component allows you to create and manage [AWS IAM Roles](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles.html) with support for inline policies, managed policies, and automatic cleanup of attached policies during deletion.

# Minimal Example

```ts twoslash
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

```ts twoslash
import { Role } from "alchemy/aws";

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
```