# Policy Attachment

The Policy Attachment component allows you to attach an [AWS IAM Policy](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies.html) to a role, enabling the role to use the permissions defined in the policy.

# Minimal Example

```ts
import { PolicyAttachment } from "alchemy/aws";

const adminAccess = await PolicyAttachment("admin-policy", {
  policyArn: "arn:aws:iam::aws:policy/AdministratorAccess",
  roleName: "my-role"
});
```

# Create the Policy Attachment

```ts
import { PolicyAttachment } from "alchemy/aws";

// Attach a custom policy to a role
const customPolicy = await PolicyAttachment("custom-policy", {
  policyArn: "arn:aws:iam::123456789012:policy/MyCustomPolicy",
  roleName: "my-role"
});

// Attach multiple policies to a role
const s3Access = await PolicyAttachment("s3-access", {
  policyArn: "arn:aws:iam::aws:policy/AmazonS3FullAccess",
  roleName: "my-role"
});

const sqsAccess = await PolicyAttachment("sqs-access", {
  policyArn: "arn:aws:iam::aws:policy/AmazonSQSFullAccess",
  roleName: "my-role"
});
```