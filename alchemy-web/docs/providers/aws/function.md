# AWS Lambda Function

The Function resource lets you create and manage [AWS Lambda functions](https://docs.aws.amazon.com/lambda/latest/dg/welcome.html) for serverless compute.

# Minimal Example

Creates a basic Lambda function with default settings.

```ts
import { Function } from "alchemy/aws";

const func = await Function("api", {
  functionName: "api-handler",
  zipPath: "./dist/api.zip", 
  roleArn: role.arn,
  handler: "index.handler"
});
```

# Create Function with Environment Variables

```ts
import { Function } from "alchemy/aws";

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

# Create Function with URL Endpoint

```ts
import { Function } from "alchemy/aws";

const api = await Function("public-api", {
  functionName: "public-api", 
  zipPath: "./dist/api.zip",
  roleArn: role.arn,
  handler: "api.handler",
  url: {
    authType: "NONE",
    cors: {
      allowOrigins: ["*"],
      allowMethods: ["GET", "POST"],
      allowHeaders: ["content-type"],
      maxAge: 86400
    }
  }
});
```