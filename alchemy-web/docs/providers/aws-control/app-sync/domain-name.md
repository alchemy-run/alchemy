---
title: Managing AWS AppSync DomainNames with Alchemy
description: Learn how to create, update, and manage AWS AppSync DomainNames using Alchemy Cloud Control.
---

# DomainName

The DomainName resource lets you create and manage [AWS AppSync DomainNames](https://docs.aws.amazon.com/appsync/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-appsync-domainname.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const domainname = await AWS.AppSync.DomainName("domainname-example", {
  DomainName: "domainname-domain",
  CertificateArn: "example-certificatearn",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A domainname resource managed by Alchemy",
});
```

## Advanced Configuration

Create a domainname with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedDomainName = await AWS.AppSync.DomainName("advanced-domainname", {
  DomainName: "domainname-domain",
  CertificateArn: "example-certificatearn",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A domainname resource managed by Alchemy",
});
```

