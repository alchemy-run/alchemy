---
title: Managing AWS DMS Certificates with Alchemy
description: Learn how to create, update, and manage AWS DMS Certificates using Alchemy Cloud Control.
---

# Certificate

The Certificate resource lets you create and manage [AWS DMS Certificates](https://docs.aws.amazon.com/dms/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-dms-certificate.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const certificate = await AWS.DMS.Certificate("certificate-example", {});
```

