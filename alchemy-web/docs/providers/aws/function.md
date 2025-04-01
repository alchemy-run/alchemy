# Function

The Function component allows you to create and manage [AWS Lambda Functions](https://docs.aws.amazon.com/lambda/latest/dg/welcome.html) with support for Node.js runtimes, custom handlers, environment variables, and function URLs. It handles deployment packaging, IAM role stabilization, and function updates.

# Minimal Example

```ts twoslash
import { Function } from "alchemy/aws";

const basicFunction = await Function("api-handler", {
  functionName: "api-handler",
  zipPath: "./dist/api.zip",
  roleArn: "arn:aws:iam::123456789012:role/execution_role",
  runtime: "nodejs20.x",
  handler: "index.handler",
  tags: {
    Environment: "production"
  }
});
```

# Create the Function

```ts twoslash
import { Function } from "alchemy/aws";

const configuredFunction = await Function("worker", {
  functionName: "worker",
  zipPath: "./dist/worker.zip",
  roleArn: "arn:aws:iam::123456789012:role/execution_role",
  runtime: "nodejs20.x",
  handler: "worker.process",
  memorySize: 512,
  timeout: 30,
  environment: {
    QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/123456789012/my-queue",
    LOG_LEVEL: "info"
  }
});
```

```ts twoslash
import { Function } from "alchemy/aws";

const apiFunction = await Function("public-api", {
  functionName: "public-api",
  zipPath: "./dist/api.zip",
  roleArn: "arn:aws:iam::123456789012:role/execution_role",
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