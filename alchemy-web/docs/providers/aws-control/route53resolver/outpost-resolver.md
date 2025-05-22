---
title: Managing AWS Route53Resolver OutpostResolvers with Alchemy
description: Learn how to create, update, and manage AWS Route53Resolver OutpostResolvers using Alchemy Cloud Control.
---

# OutpostResolver

The OutpostResolver resource lets you create and manage [AWS Route53Resolver OutpostResolvers](https://docs.aws.amazon.com/route53resolver/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-route53resolver-outpostresolver.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const outpostresolver = await AWS.Route53Resolver.OutpostResolver("outpostresolver-example", {
  OutpostArn: "example-outpostarn",
  PreferredInstanceType: "example-preferredinstancetype",
  Name: "outpostresolver-",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a outpostresolver with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedOutpostResolver = await AWS.Route53Resolver.OutpostResolver(
  "advanced-outpostresolver",
  {
    OutpostArn: "example-outpostarn",
    PreferredInstanceType: "example-preferredinstancetype",
    Name: "outpostresolver-",
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

