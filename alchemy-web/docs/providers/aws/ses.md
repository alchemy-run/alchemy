# SES

The SES component lets you manage [Amazon Simple Email Service (SES)](https://docs.aws.amazon.com/ses/latest/dg/Welcome.html) configuration sets and email identities.

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

Create and verify a domain identity with DKIM enabled.

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

# Configure Email Sending Options

Configure advanced sending options for a configuration set.

```ts
import { SES } from "alchemy/aws";

const emailConfig = await SES("email-config", {
  configurationSetName: "my-email-config",
  sendingOptions: {
    SendingEnabled: true
  },
  reputationOptions: {
    ReputationMetricsEnabled: true
  },
  suppressionOptions: {
    SuppressedReasons: ["BOUNCE", "COMPLAINT"]
  },
  deliveryOptions: {
    TlsPolicy: "REQUIRE",
    SendingPoolName: "prod-pool"
  }
});
```