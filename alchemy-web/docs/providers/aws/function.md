# Function

The Function component allows you to create and manage [AWS Lambda functions](https://docs.aws.amazon.com/lambda/latest/dg/welcome.html) with support for Node.js runtimes, custom handlers, environment variables, and function URLs. It handles deployment packaging, IAM role stabilization, and function updates.

# Minimal Example

```ts
import { Function } from "alchemy/aws";

const basicFunction = await Function("api-handler", {
  functionName: "api-handler",
  zipPath: "./dist/api.zip",
  roleArn: "arn:aws:iam::123456789012:role/execution_role",
  runtime: "nodejs20.x",
  handler: "index.handler",
});
```

# Create the Function

```ts
import { Function } from "alchemy/aws";

// Create a basic Lambda function with minimal configuration
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

// Create a function with environment variables and custom memory/timeout
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

// Create a function with a public URL endpoint and CORS
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