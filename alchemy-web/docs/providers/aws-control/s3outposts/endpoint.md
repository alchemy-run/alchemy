---
title: Managing AWS S3Outposts Endpoints with Alchemy
description: Learn how to create, update, and manage AWS S3Outposts Endpoints using Alchemy Cloud Control.
---

# Endpoint

The Endpoint resource lets you create and manage [AWS S3Outposts Endpoints](https://docs.aws.amazon.com/s3outposts/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-s3outposts-endpoint.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const endpoint = await AWS.S3Outposts.Endpoint("endpoint-example", {
  OutpostId: "example-outpostid",
  SecurityGroupId: "example-securitygroupid",
  SubnetId: "example-subnetid",
});
```

