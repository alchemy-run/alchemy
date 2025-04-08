# SES

The SES component lets you manage [Amazon Simple Email Service (SES)](https://aws.amazon.com/ses/) configuration sets and email identities.

# Minimal Example

Create a basic SES configuration set for email sending.

```ts
import { SES } from "alchemy/aws";

const configSet = await SES("email-config", {
  configurationSetName: "my-email-config",
  sendingOptions: {
    SendingEnabled: true
  }
});
```

# Create an Email Identity

Create and verify a domain identity with DKIM signing enabled.

```ts
import { SES } from "alchemy/aws";

const domainIdentity = await SES("domain-identity", {
  emailIdentity: "example.com", 
  enableDkim: true,
  tags: {
    Environment: "production"
  }
});
```