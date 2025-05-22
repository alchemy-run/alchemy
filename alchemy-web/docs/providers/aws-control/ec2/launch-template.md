---
title: Managing AWS EC2 LaunchTemplates with Alchemy
description: Learn how to create, update, and manage AWS EC2 LaunchTemplates using Alchemy Cloud Control.
---

# LaunchTemplate

The LaunchTemplate resource lets you create and manage [AWS EC2 LaunchTemplates](https://docs.aws.amazon.com/ec2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-launchtemplate.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const launchtemplate = await AWS.EC2.LaunchTemplate("launchtemplate-example", {
  LaunchTemplateData: "example-launchtemplatedata",
});
```

