---
title: Managing AWS Route53 RecordSets with Alchemy
description: Learn how to create, update, and manage AWS Route53 RecordSets using Alchemy Cloud Control.
---

# RecordSet

The RecordSet resource lets you create and manage [AWS Route53 RecordSets](https://docs.aws.amazon.com/route53/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-route53-recordset.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const recordset = await AWS.Route53.RecordSet("recordset-example", {
  Name: "recordset-",
  Type: "example-type",
});
```

