---
title: Managing AWS ServiceDiscovery PublicDnsNamespaces with Alchemy
description: Learn how to create, update, and manage AWS ServiceDiscovery PublicDnsNamespaces using Alchemy Cloud Control.
---

# PublicDnsNamespace

The PublicDnsNamespace resource lets you create and manage [AWS ServiceDiscovery PublicDnsNamespaces](https://docs.aws.amazon.com/servicediscovery/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-servicediscovery-publicdnsnamespace.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const publicdnsnamespace = await AWS.ServiceDiscovery.PublicDnsNamespace(
  "publicdnsnamespace-example",
  {
    Name: "publicdnsnamespace-",
    Tags: { Environment: "production", ManagedBy: "Alchemy" },
    Description: "A publicdnsnamespace resource managed by Alchemy",
  }
);
```

## Advanced Configuration

Create a publicdnsnamespace with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedPublicDnsNamespace = await AWS.ServiceDiscovery.PublicDnsNamespace(
  "advanced-publicdnsnamespace",
  {
    Name: "publicdnsnamespace-",
    Tags: {
      Environment: "production",
      Team: "DevOps",
      Project: "MyApp",
      CostCenter: "Engineering",
      ManagedBy: "Alchemy",
    },
    Description: "A publicdnsnamespace resource managed by Alchemy",
  }
);
```

