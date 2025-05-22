---
title: Managing AWS SecurityHub FindingAggregators with Alchemy
description: Learn how to create, update, and manage AWS SecurityHub FindingAggregators using Alchemy Cloud Control.
---

# FindingAggregator

The FindingAggregator resource lets you create and manage [AWS SecurityHub FindingAggregators](https://docs.aws.amazon.com/securityhub/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-securityhub-findingaggregator.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const findingaggregator = await AWS.SecurityHub.FindingAggregator("findingaggregator-example", {
  RegionLinkingMode: "example-regionlinkingmode",
});
```

