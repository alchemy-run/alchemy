---
title: Managing AWS RolesAnywhere CRLs with Alchemy
description: Learn how to create, update, and manage AWS RolesAnywhere CRLs using Alchemy Cloud Control.
---

# CRL

The CRL resource lets you create and manage [AWS RolesAnywhere CRLs](https://docs.aws.amazon.com/rolesanywhere/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-rolesanywhere-crl.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const crl = await AWS.RolesAnywhere.CRL("crl-example", {
  CrlData: "example-crldata",
  Name: "crl-",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a crl with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedCRL = await AWS.RolesAnywhere.CRL("advanced-crl", {
  CrlData: "example-crldata",
  Name: "crl-",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

