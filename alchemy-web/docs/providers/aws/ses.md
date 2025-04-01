# SES

The SES component allows you to manage [Amazon Simple Email Service (SES)](https://docs.aws.amazon.com/ses/latest/DeveloperGuide/Welcome.html) resources, including configuration sets and email identities, with support for DKIM signing and identity verification.

# Minimal Example

```ts twoslash
import { SES } from "alchemy/aws";

const configSet = await SES("email-config", {
  configurationSetName: "my-email-config",
  sendingOptions: {
    SendingEnabled: true
  },
  tags: {
    Environment: "production",
    Project: "notifications"
  }
});
```

# Create the SES

```ts twoslash
import { SES } from "alchemy/aws";

// Create and verify a domain identity with DKIM
const domainIdentity = await SES("domain-identity", {
  emailIdentity: "example.com",
  enableDkim: true,
  tags: {
    Environment: "production",
    Project: "transactional-emails"
  }
});
```