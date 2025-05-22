---
title: Managing AWS ElasticBeanstalk Environments with Alchemy
description: Learn how to create, update, and manage AWS ElasticBeanstalk Environments using Alchemy Cloud Control.
---

# Environment

The Environment resource lets you create and manage [AWS ElasticBeanstalk Environments](https://docs.aws.amazon.com/elasticbeanstalk/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-elasticbeanstalk-environment.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const environment = await AWS.ElasticBeanstalk.Environment("environment-example", {
  ApplicationName: "environment-application",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A environment resource managed by Alchemy",
});
```

## Advanced Configuration

Create a environment with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedEnvironment = await AWS.ElasticBeanstalk.Environment("advanced-environment", {
  ApplicationName: "environment-application",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A environment resource managed by Alchemy",
});
```

