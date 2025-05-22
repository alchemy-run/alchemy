---
title: Managing AWS WorkSpacesWeb TrustStores with Alchemy
description: Learn how to create, update, and manage AWS WorkSpacesWeb TrustStores using Alchemy Cloud Control.
---

# TrustStore

The TrustStore resource lets you create and manage [AWS WorkSpacesWeb TrustStores](https://docs.aws.amazon.com/workspacesweb/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-workspacesweb-truststore.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const truststore = await AWS.WorkSpacesWeb.TrustStore("truststore-example", {
  CertificateList: ["example-certificatelist-1"],
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a truststore with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedTrustStore = await AWS.WorkSpacesWeb.TrustStore("advanced-truststore", {
  CertificateList: ["example-certificatelist-1"],
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

