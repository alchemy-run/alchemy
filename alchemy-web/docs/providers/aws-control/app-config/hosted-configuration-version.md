---
title: Managing AWS AppConfig HostedConfigurationVersions with Alchemy
description: Learn how to create, update, and manage AWS AppConfig HostedConfigurationVersions using Alchemy Cloud Control.
---

# HostedConfigurationVersion

The HostedConfigurationVersion resource lets you create and manage [AWS AppConfig HostedConfigurationVersions](https://docs.aws.amazon.com/appconfig/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-appconfig-hostedconfigurationversion.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const hostedconfigurationversion = await AWS.AppConfig.HostedConfigurationVersion(
  "hostedconfigurationversion-example",
  {
    ConfigurationProfileId: "example-configurationprofileid",
    ContentType: "example-contenttype",
    Content: "example-content",
    ApplicationId: "example-applicationid",
    Description: "A hostedconfigurationversion resource managed by Alchemy",
  }
);
```

## Advanced Configuration

Create a hostedconfigurationversion with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedHostedConfigurationVersion = await AWS.AppConfig.HostedConfigurationVersion(
  "advanced-hostedconfigurationversion",
  {
    ConfigurationProfileId: "example-configurationprofileid",
    ContentType: "example-contenttype",
    Content: "example-content",
    ApplicationId: "example-applicationid",
    Description: "A hostedconfigurationversion resource managed by Alchemy",
  }
);
```

