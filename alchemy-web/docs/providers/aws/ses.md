# Ses

The Ses component allows you to manage [Amazon Simple Email Service (SES)](https://docs.aws.amazon.com/ses/latest/DeveloperGuide/Welcome.html) resources, including configuration sets and email identities, with support for DKIM signing and identity verification.

# Minimal Example

```ts
import { Ses } from "alchemy/aws";

const sesResource = await Ses("email-config", {
  configurationSetName: "my-email-config",
  sendingOptions: {
    SendingEnabled: true,
  },
  tags: {
    Environment: "production",
    Project: "notifications",
  },
});
```

# Create the Ses

```ts
import { Ses } from "alchemy/aws";

// Create a configuration set with sending options
const configSet = await Ses("email-config", {
  configurationSetName: "my-email-config",
  sendingOptions: {
    SendingEnabled: true,
  },
  tags: {
    Environment: "production",
    Project: "notifications",
  },
});

// Create and verify a domain identity with DKIM
const domainIdentity = await Ses("domain-identity", {
  emailIdentity: "example.com",
  enableDkim: true,
  tags: {
    Environment: "production",
    Project: "transactional-emails",
  },
});

// Update configuration set sending options
const updatedConfig = await Ses("email-config", {
  configurationSetName: "my-email-config",
  sendingOptions: {
    SendingEnabled: false,
  },
  tags: {
    Environment: "production",
    Project: "notifications",
    Updated: "true",
  },
});
```