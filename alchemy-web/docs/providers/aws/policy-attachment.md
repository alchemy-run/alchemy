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

const customPolicy = await PolicyAttachment("custom-policy", {
  policyArn: "arn:aws:iam::123456789012:policy/MyCustomPolicy",
  roleName: "my-custom-role"
});
```