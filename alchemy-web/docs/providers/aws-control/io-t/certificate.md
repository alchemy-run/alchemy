---
title: Managing AWS IoT Certificates with Alchemy
description: Learn how to create, update, and manage AWS IoT Certificates using Alchemy Cloud Control.
---

# Certificate

The Certificate resource lets you create and manage [AWS IoT Certificates](https://docs.aws.amazon.com/iot/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-iot-certificate.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const certificate = await AWS.IoT.Certificate("certificate-example", { Status: "example-status" });
```

