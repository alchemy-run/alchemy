---
title: Managing AWS CustomerProfiles EventStreams with Alchemy
description: Learn how to create, update, and manage AWS CustomerProfiles EventStreams using Alchemy Cloud Control.
---

# EventStream

The EventStream resource lets you create and manage [AWS CustomerProfiles EventStreams](https://docs.aws.amazon.com/customerprofiles/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-customerprofiles-eventstream.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const eventstream = await AWS.CustomerProfiles.EventStream("eventstream-example", {
  DomainName: "eventstream-domain",
  EventStreamName: "eventstream-eventstream",
  Uri: "example-uri",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a eventstream with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedEventStream = await AWS.CustomerProfiles.EventStream("advanced-eventstream", {
  DomainName: "eventstream-domain",
  EventStreamName: "eventstream-eventstream",
  Uri: "example-uri",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

