# AWS Lambda Function

The [AWS Lambda Function](https://docs.aws.amazon.com/lambda/latest/dg/welcome.html) resource lets you create and manage Lambda functions that run code in response to events.

## Minimal Example

Create a basic Lambda function with default settings:

```ts
import { Function } from "alchemy/aws";

const func = await Function("api", {
  functionName: "api-handler",
  zipPath: "./dist/api.zip", 
  roleArn: role.arn,
  handler: "index.handler"
});
```

## Custom Configuration

Configure memory, timeout and environment variables:

```ts
const func = await Function("worker", {
  functionName: "worker",
  zipPath: "./dist/worker.zip",
  roleArn: role.arn,
  handler: "worker.process",
  memorySize: 512,
  timeout: 30,
  environment: {
    QUEUE_URL: queue.url,
    LOG_LEVEL: "info"
  }
});
```

## Function URL

Create a function with a public URL endpoint, CORS and optional response streaming:

```ts
const func = await Function("public-api", {
  functionName: "public-api", 
  zipPath: "./dist/api.zip",
  roleArn: role.arn,
  handler: "api.handler",
  url: {
    authType: "NONE",
    invokeMode: "RESPONSE_STREAM",
    cors: {
      allowOrigins: ["*"],
      allowMethods: ["GET", "POST"],
      allowHeaders: ["content-type"]
    }
  }
});
```