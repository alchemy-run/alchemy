---
title: Managing AWS ElasticBeanstalk ConfigurationTemplates with Alchemy
description: Learn how to create, update, and manage AWS ElasticBeanstalk ConfigurationTemplates using Alchemy Cloud Control.
---

# ConfigurationTemplate

The ConfigurationTemplate resource lets you create and manage [AWS ElasticBeanstalk ConfigurationTemplates](https://docs.aws.amazon.com/elasticbeanstalk/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-elasticbeanstalk-configurationtemplate.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const configurationtemplate = await AWS.ElasticBeanstalk.ConfigurationTemplate(
  "configurationtemplate-example",
  {
    ApplicationName: "configurationtemplate-application",
    Description: "A configurationtemplate resource managed by Alchemy",
  }
);
```

## Advanced Configuration

Create a configurationtemplate with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedConfigurationTemplate = await AWS.ElasticBeanstalk.ConfigurationTemplate(
  "advanced-configurationtemplate",
  {
    ApplicationName: "configurationtemplate-application",
    Description: "A configurationtemplate resource managed by Alchemy",
  }
);
```

