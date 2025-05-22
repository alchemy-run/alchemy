---
title: Managing AWS GlobalAccelerator EndpointGroups with Alchemy
description: Learn how to create, update, and manage AWS GlobalAccelerator EndpointGroups using Alchemy Cloud Control.
---

# EndpointGroup

The EndpointGroup resource lets you create and manage [AWS GlobalAccelerator EndpointGroups](https://docs.aws.amazon.com/globalaccelerator/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-globalaccelerator-endpointgroup.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const endpointgroup = await AWS.GlobalAccelerator.EndpointGroup("endpointgroup-example", {
  ListenerArn: "example-listenerarn",
  EndpointGroupRegion: "example-endpointgroupregion",
});
```

