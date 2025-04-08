# Function

The Function Resource lets you create and manage [AWS Lambda Functions](https://docs.aws.amazon.com/lambda/latest/dg/welcome.html) for serverless compute.

# Minimal Example

Create a basic Lambda function with minimal configuration.

```ts
import { Function } from "alchemy/aws";

const func = await Function("api-handler", {
  functionName: "api-handler", 
  zipPath: "./dist/api.zip",
  roleArn: role.arn,
  handler: "index.handler",
  runtime: "nodejs20.x"
});
```

# Create a Function with Environment Variables

Create a function with environment variables and custom memory/timeout settings.

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

# Create a Function with URL Endpoint

Create a function with a public URL endpoint and CORS configuration.

```ts
import { Function } from "alchemy/aws";

const func = await Function("public-api", {
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