# Policy Attachment

The Policy Attachment resource lets you attach [AWS IAM policies](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies.html) to IAM roles.

# Minimal Example

Attach an AWS managed policy to a role.

```ts
import { PolicyAttachment } from "alchemy/aws";

const adminAccess = await PolicyAttachment("admin-policy", {
  policyArn: "arn:aws:iam::aws:policy/AdministratorAccess", 
  roleName: role.name
});
```

# Create the Policy Attachment

```ts
import { PolicyAttachment } from "alchemy/aws";

// Attach multiple policies to a role
const s3Access = await PolicyAttachment("s3-access", {
  policyArn: "arn:aws:iam::aws:policy/AmazonS3FullAccess",
  roleName: role.name
});

const sqsAccess = await PolicyAttachment("sqs-access", {
  policyArn: "arn:aws:iam::aws:policy/AmazonSQSFullAccess", 
  roleName: role.name
});
```