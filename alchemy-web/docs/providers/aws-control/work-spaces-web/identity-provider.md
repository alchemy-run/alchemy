---
title: Managing AWS WorkSpacesWeb IdentityProviders with Alchemy
description: Learn how to create, update, and manage AWS WorkSpacesWeb IdentityProviders using Alchemy Cloud Control.
---

# IdentityProvider

The IdentityProvider resource lets you create and manage [AWS WorkSpacesWeb IdentityProviders](https://docs.aws.amazon.com/workspacesweb/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-workspacesweb-identityprovider.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const identityprovider = await AWS.WorkSpacesWeb.IdentityProvider("identityprovider-example", {
  IdentityProviderDetails: {},
  IdentityProviderName: "identityprovider-identityprovider",
  IdentityProviderType: "example-identityprovidertype",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a identityprovider with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedIdentityProvider = await AWS.WorkSpacesWeb.IdentityProvider(
  "advanced-identityprovider",
  {
    IdentityProviderDetails: {},
    IdentityProviderName: "identityprovider-identityprovider",
    IdentityProviderType: "example-identityprovidertype",
    Tags: {
      Environment: "production",
      Team: "DevOps",
      Project: "MyApp",
      CostCenter: "Engineering",
      ManagedBy: "Alchemy",
    },
  }
);
```

