# AWS Lambda Function

The Function resource lets you create and manage [AWS Lambda functions](https://docs.aws.amazon.com/lambda/latest/dg/welcome.html) for serverless compute.

## Minimal Example

Create a basic Lambda function with default settings.

```ts
import { Function } from "alchemy/aws";

const func = await Function("api", {
  functionName: "my-api",
  bundle: bundle,
  roleArn: role.arn,
  handler: "index.handler"
});
```

## Custom Runtime and Memory

Configure the function's runtime, memory and timeout.

```ts
const func = await Function("worker", {
  functionName: "worker",
  bundle: bundle,
  roleArn: role.arn,
  handler: "worker.process",
  runtime: Runtime.nodejs20x,
  memorySize: 512,
  timeout: 30,
  environment: {
    QUEUE_URL: queue.url,
    LOG_LEVEL: "info"
  }
});
```

## Function URL

Create a function with a public URL endpoint and CORS configuration.

```ts
const api = await Function("public-api", {
  functionName: "public-api", 
  bundle: bundle,
  roleArn: role.arn,
  handler: "api.handler",
  url: {
    authType: "NONE",
    invokeMode: "RESPONSE_STREAM",
    cors: {
      allowOrigins: ["*"],
      allowMethods: ["GET", "POST"],
      allowHeaders: ["content-type"],
      maxAge: 86400
    }
  }
});
```