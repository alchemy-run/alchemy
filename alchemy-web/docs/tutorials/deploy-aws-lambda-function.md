# Bundling and Deploying an AWS Lambda Function

## Overview

In this tutorial, you'll learn how to use Alchemy to bundle and deploy an AWS Lambda function. Alchemy is a TypeScript-native Infrastructure-as-Code (IaC) library that makes it easy to define, deploy, and manage cloud resources. By the end of this tutorial, you'll have created an AWS Lambda function that can interact with an S3 bucket.

## Prerequisites

- Basic knowledge of TypeScript and AWS
- AWS account with appropriate permissions
- [Get started with Alchemy](/docs/getting-started)
- [AWS provider setup](https://aws.amazon.com/getting-started/)
- AWS credentials configured locally

## Setup

Create a new directory for your project and initialize it:

```bash
mkdir lambda-tutorial
cd lambda-tutorial
bun init -y
```

## Step 1: Create the Alchemy Configuration

Create a file called `alchemy.run.ts` in your project root:

```typescript
import alchemy from "alchemy";
import { Bucket, Function, Role } from "alchemy/aws";
import { Bundle } from "alchemy/esbuild";
import path from "node:path";

await using app = alchemy("lambda-tutorial", {
  stage: process.env.STAGE || "dev",
  phase: process.argv.includes("--destroy") ? "destroy" : "up"
});
```

This initializes your Alchemy application with a stage name and determines whether to create/update resources or destroy them based on command-line arguments.

## Step 2: Create a Lambda Handler

Create a directory for your source code and add a Lambda handler file:

```bash
mkdir -p src
```

Create `src/index.ts` with a simple Lambda function:

```typescript
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({});

export const handler = async (event: any) => {
  try {
    // Upload a simple text file to S3
    await s3.send(new PutObjectCommand({
      Bucket: process.env.BUCKET_NAME,
      Key: `file-${Date.now()}.txt`,
      Body: `Hello from Lambda! Event: ${JSON.stringify(event)}`,
      ContentType: 'text/plain'
    }));
    
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "File uploaded successfully!",
        timestamp: new Date().toISOString()
      })
    };
  } catch (error) {
    console.error("Error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: "Error uploading file",
        error: String(error)
      })
    };
  }
};
```

This Lambda function will upload a text file to an S3 bucket whenever it's invoked.

## Step 3: Create an S3 Bucket

Add the S3 bucket resource to your `alchemy.run.ts` file:

```typescript
const bucket = await Bucket("storage-bucket", {
  bucketName: `lambda-tutorial-${app.stage}-${Date.now().toString().slice(-6)}`,
  tags: {
    Environment: app.stage,
    Project: "LambdaTutorial"
  }
});
```

The bucket name includes a timestamp suffix to ensure global uniqueness.

## Step 4: Create an IAM Role

Add an IAM role with permissions to access the S3 bucket:

```typescript
const role = await Role("lambda-role", {
  roleName: `lambda-tutorial-role-${app.stage}`,
  assumeRolePolicy: {
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Principal: {
        Service: "lambda.amazonaws.com"
      },
      Action: "sts:AssumeRole"
    }]
  },
  policies: [
    {
      policyName: "s3-access",
      policyDocument: {
        Version: "2012-10-17",
        Statement: [{
          Effect: "Allow",
          Action: [
            "s3:PutObject",
            "s3:GetObject",
            "s3:ListBucket"
          ],
          Resource: [
            bucket.arn,
            `${bucket.arn}/*`
          ]
        }]
      }
    },
    {
      policyName: "lambda-logs",
      policyDocument: {
        Version: "2012-10-17",
        Statement: [{
          Effect: "Allow",
          Action: [
            "logs:CreateLogGroup",
            "logs:CreateLogStream",
            "logs:PutLogEvents"
          ],
          Resource: "arn:aws:logs:*:*:*"
        }]
      }
    }
  ]
});
```

This role allows the Lambda function to write logs and interact with the S3 bucket.

## Step 5: Bundle and Deploy the Lambda Function

Finally, bundle and deploy the Lambda function:

```typescript
const bundle = await Bundle("lambda-bundle", {
  entryPoint: path.join(process.cwd(), "src", "index.ts"),
  outdir: ".out",
  format: "cjs",
  platform: "node",
  target: "node18",
  minify: true,
  external: ["@aws-sdk/*"] // Don't bundle AWS SDK
});

const lambda = await Function("file-uploader", {
  functionName: `lambda-tutorial-${app.stage}`,
  zipPath: bundle.path,
  roleArn: role.arn,
  handler: "index.handler",
  runtime: "nodejs18.x",
  environment: {
    BUCKET_NAME: bucket.bucketName
  },
  tags: {
    Environment: app.stage,
    Project: "LambdaTutorial"
  }
});

console.log({
  bucketName: bucket.bucketName,
  functionName: lambda.functionName,
  functionArn: lambda.arn
});
```

This code bundles your TypeScript Lambda function using esbuild, then creates the Lambda function with the appropriate configuration.

## Testing Your Work

Deploy your Lambda function:

```bash
bun alchemy.run.ts
```

You should see output with your bucket name, function name, and function ARN.

To test the Lambda function, you can invoke it using the AWS CLI:

```bash
aws lambda invoke \
  --function-name lambda-tutorial-dev \
  --payload '{"test": "event"}' \
  response.json

cat response.json
```

You should see a success message. Check your S3 bucket in the AWS Console to verify that a file was uploaded.

To clean up all resources when you're done:

```bash
bun alchemy.run.ts --destroy
```

Congratulations! You've successfully bundled and deployed an AWS Lambda function using Alchemy.