---
title: Managing AWS Route53Resolver ResolverQueryLoggingConfigs with Alchemy
description: Learn how to create, update, and manage AWS Route53Resolver ResolverQueryLoggingConfigs using Alchemy Cloud Control.
---

# ResolverQueryLoggingConfig

The ResolverQueryLoggingConfig resource lets you create and manage [AWS Route53Resolver ResolverQueryLoggingConfigs](https://docs.aws.amazon.com/route53resolver/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-route53resolver-resolverqueryloggingconfig.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const resolverqueryloggingconfig = await AWS.Route53Resolver.ResolverQueryLoggingConfig(
  "resolverqueryloggingconfig-example",
  { Tags: { Environment: "production", ManagedBy: "Alchemy" } }
);
```

## Advanced Configuration

Create a resolverqueryloggingconfig with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedResolverQueryLoggingConfig = await AWS.Route53Resolver.ResolverQueryLoggingConfig(
  "advanced-resolverqueryloggingconfig",
  {
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

