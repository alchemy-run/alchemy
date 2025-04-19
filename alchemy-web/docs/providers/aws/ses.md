# SES

The SES resource lets you manage [Amazon Simple Email Service (SES)](https://docs.aws.amazon.com/ses/latest/dg/Welcome.html) configuration sets and email identities.

## Minimal Example

Create a basic SES configuration set for email sending:

```ts
import { SES } from "alchemy/aws";

const configSet = await SES("email-config", {
  configurationSetName: "my-email-config",
  sendingOptions: {
    SendingEnabled: true
  }
});
```

## Email Identity with DKIM

Create and verify a domain identity with DKIM signing enabled:

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

## Configuration Set with Options

Create a configuration set with sending, tracking and delivery options:

```ts
import { SES } from "alchemy/aws";

const emailConfig = await SES("email-config", {
  configurationSetName: "my-email-config",
  sendingOptions: {
    SendingEnabled: true
  },
  trackingOptions: {
    CustomRedirectDomain: "click.example.com"
  },
  deliveryOptions: {
    TlsPolicy: "REQUIRE",
    SendingPoolName: "prod-pool"
  }
});
```