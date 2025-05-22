---
title: Managing AWS ServiceDiscovery HttpNamespaces with Alchemy
description: Learn how to create, update, and manage AWS ServiceDiscovery HttpNamespaces using Alchemy Cloud Control.
---

# HttpNamespace

The HttpNamespace resource lets you create and manage [AWS ServiceDiscovery HttpNamespaces](https://docs.aws.amazon.com/servicediscovery/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-servicediscovery-httpnamespace.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const httpnamespace = await AWS.ServiceDiscovery.HttpNamespace("httpnamespace-example", {
  Name: "httpnamespace-",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A httpnamespace resource managed by Alchemy",
});
```

## Advanced Configuration

Create a httpnamespace with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedHttpNamespace = await AWS.ServiceDiscovery.HttpNamespace("advanced-httpnamespace", {
  Name: "httpnamespace-",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A httpnamespace resource managed by Alchemy",
});
```

