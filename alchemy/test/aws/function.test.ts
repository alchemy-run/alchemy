import {
  GetFunctionCommand,
  InvokeCommand,
  LambdaClient,
  ResourceNotFoundException,
} from "@aws-sdk/client-lambda";
import { describe, expect } from "bun:test";
import path from "node:path";
import { alchemy } from "../../src/alchemy";
import { Function } from "../../src/aws/function";
import type { PolicyDocument } from "../../src/aws/policy";
import { Role } from "../../src/aws/role";
import { destroy } from "../../src/destroy";
import { Bundle } from "../../src/esbuild";
import "../../src/test/bun";
import { BRANCH_PREFIX } from "../util";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

const __dirname = path.dirname(new URL(import.meta.url).pathname);

const lambda = new LambdaClient({});

// Common policy definitions
const LAMBDA_ASSUME_ROLE_POLICY: PolicyDocument = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Principal: {
        Service: "lambda.amazonaws.com",
      },
      Action: "sts:AssumeRole",
    },
  ],
};

const LAMBDA_LOGS_POLICY: PolicyDocument = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Action: [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents",
      ],
      Resource: "*",
    },
  ],
};

// Helper function to invoke a Lambda function directly
const invokeLambda = async (functionName: string, event: any) => {
  const invokeResponse = await lambda.send(
    new InvokeCommand({
      FunctionName: functionName,
      Payload: JSON.stringify(event),
    })
  );

  const responsePayload = new TextDecoder().decode(invokeResponse.Payload);
  return JSON.parse(responsePayload);
};

describe("AWS Resources", () => {
  describe("Function", () => {
    test("create function with bundled code", async (scope) => {
      // First create the execution role
      // Define resources that need to be cleaned up
      let role: Role | undefined = undefined;
      let bundle: Bundle | undefined = undefined;
      let func: Function | null = null;
      const functionName = `${BRANCH_PREFIX}-alchemy-test-function`;
      const roleName = `${BRANCH_PREFIX}-alchemy-test-lambda-role`;

      try {
        bundle = await Bundle(`${BRANCH_PREFIX}-test-lambda-bundle`, {
          entryPoint: path.join(__dirname, "..", "handler.ts"),
          outdir: ".out",
          format: "cjs",
          platform: "node",
          target: "node18",
        });

        role = await Role(roleName, {
          roleName,
          assumeRolePolicy: LAMBDA_ASSUME_ROLE_POLICY,
          description: "Test role for Lambda function",
          policies: [
            {
              policyName: "logs",
              policyDocument: LAMBDA_LOGS_POLICY,
            },
          ],
          tags: {
            Environment: "test",
          },
        });

        // Create the Lambda function
        func = await Function(functionName, {
          functionName,
          zipPath: bundle.path,
          roleArn: role.arn,
          handler: "handler.handler",
          runtime: "nodejs20.x",
          tags: {
            Environment: "test",
          },
        });

        expect(func.arn).toMatch(
          new RegExp(
            `^arn:aws:lambda:[a-z0-9-]+:\\d+:function:${functionName}$`
          )
        );
        expect(func.state).toBe("Active");
        expect(func.lastUpdateStatus).toBe("Successful");
        expect(func.invokeArn).toMatch(
          new RegExp(
            `^arn:aws:apigateway:[a-z0-9-]+:lambda:path\\/2015-03-31\\/functions\\/arn:aws:lambda:[a-z0-9-]+:\\d+:function:${functionName}\\/invocations$`
          )
        );

        // Immediately apply again to test stabilization logic
        expect(func.state).toBe("Active");
        expect(func.lastUpdateStatus).toBe("Successful");

        // Invoke the function
        const testEvent = { test: "event" };
        const invokeResponse = await lambda.send(
          new InvokeCommand({
            FunctionName: functionName,
            Payload: JSON.stringify(testEvent),
          })
        );

        // Parse the response
        const responsePayload = new TextDecoder().decode(
          invokeResponse.Payload
        );
        const response = JSON.parse(responsePayload);
        expect(response.statusCode).toBe(200);

        const body = JSON.parse(response.body);
        expect(body.message).toBe("Hello from bundled handler!");
        expect(body.event).toEqual(testEvent);
      } finally {
        await destroy(scope);

        // Verify function was properly deleted after cleanup
        if (func) {
          await expect(
            lambda.send(
              new GetFunctionCommand({
                FunctionName: functionName,
              })
            )
          ).rejects.toThrow(ResourceNotFoundException);
        }
      }
    });

    test("create function with URL configuration", async (scope) => {
      // Create execution role
      // Define resources that need to be cleaned up
      let role: Role | undefined = undefined;
      let bundle: Bundle | undefined = undefined;
      let func: Function | null = null;
      const functionName = `${BRANCH_PREFIX}-alchemy-test-function-url`;
      const roleName = `${BRANCH_PREFIX}-alchemy-test-lambda-url-role`;

      try {
        bundle = await Bundle(`${BRANCH_PREFIX}-test-lambda-url-bundle`, {
          entryPoint: path.join(__dirname, "..", "handler.ts"),
          outdir: ".out",
          format: "cjs",
          platform: "node",
          target: "node18",
        });

        role = await Role(roleName, {
          roleName,
          assumeRolePolicy: LAMBDA_ASSUME_ROLE_POLICY,
          description: "Test role for Lambda function with URL",
          policies: [
            {
              policyName: "logs",
              policyDocument: LAMBDA_LOGS_POLICY,
            },
          ],
          tags: {
            Environment: "test",
          },
        });

        // Create the Lambda function with URL config
        func = await Function(functionName, {
          functionName,
          zipPath: bundle.path,
          roleArn: role.arn,
          handler: "handler.handler",
          runtime: "nodejs20.x",
          tags: {
            Environment: "test",
          },
          url: {
            authType: "NONE",
            cors: {
              allowOrigins: ["*"],
              allowMethods: ["GET", "POST"],
              allowHeaders: ["Content-Type"],
            },
          },
        });

        // Verify function was created with URL
        expect(func.arn).toMatch(
          new RegExp(
            `^arn:aws:lambda:[a-z0-9-]+:\\d+:function:${functionName}$`
          )
        );
        expect(func.state).toBe("Active");
        expect(func.lastUpdateStatus).toBe("Successful");
        expect(func.functionUrl).toBeTruthy();
        expect(func.functionUrl).toMatch(
          /^https:\/\/.+\.lambda-url\..+\.on\.aws\/?$/
        );

        // Test function URL by making an HTTP request
        const testEvent = { test: "event" };
        const response = await fetch(func.functionUrl!, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(testEvent),
        });

        expect(response.status).toBe(200);

        const responseBody = await response.json();
        expect(responseBody.message).toBe("Hello from bundled handler!");
        expect(responseBody.event).toEqual(testEvent);

        // Update the function to remove the URL
        func = await Function(functionName, {
          functionName,
          zipPath: bundle.path,
          roleArn: role.arn,
          handler: "handler.handler",
          runtime: "nodejs20.x",
          tags: {
            Environment: "test",
          },
          // No URL config means it should be removed
        });

        // Verify URL was removed
        expect(func.functionUrl).toBeUndefined();
      } finally {
        await destroy(scope);

        // Verify function was properly deleted after cleanup
        if (func) {
          await expect(
            lambda.send(
              new GetFunctionCommand({
                FunctionName: functionName,
              })
            )
          ).rejects.toThrow(ResourceNotFoundException);
        }
      }
    });

    test("create function with URL then remove URL in update phase", async (scope) => {
      // Define resources that need to be cleaned up
      let role: Role | undefined = undefined;
      let bundle: Bundle | undefined = undefined;
      let func: Function | null = null;
      const functionName = `${BRANCH_PREFIX}-alchemy-test-func-url-remove`;
      const roleName = `${BRANCH_PREFIX}-alchemy-test-lambda-url-rem-role`;

      try {
        bundle = await Bundle(
          `${BRANCH_PREFIX}-test-lambda-url-remove-bundle`,
          {
            entryPoint: path.join(__dirname, "..", "handler.ts"),
            outdir: ".out",
            format: "cjs",
            platform: "node",
            target: "node18",
          }
        );

        role = await Role(roleName, {
          roleName,
          assumeRolePolicy: LAMBDA_ASSUME_ROLE_POLICY,
          description: "Test role for Lambda function",
          policies: [
            {
              policyName: "logs",
              policyDocument: LAMBDA_LOGS_POLICY,
            },
          ],
          tags: {
            Environment: "test",
          },
        });

        // Create the Lambda function with URL config
        func = await Function(functionName, {
          functionName,
          zipPath: bundle.path,
          roleArn: role.arn,
          handler: "handler.handler",
          runtime: "nodejs20.x",
          tags: {
            Environment: "test",
          },
          url: {
            authType: "NONE",
            cors: {
              allowOrigins: ["*"],
              allowMethods: ["GET", "POST"],
              allowHeaders: ["Content-Type"],
            },
          },
        });

        // Verify function was created with URL
        expect(func.arn).toBeTruthy();
        expect(func.state).toBe("Active");
        expect(func.functionUrl).toBeTruthy();

        // Test function URL invocation
        const testEvent = { test: "url-event" };
        const urlResponse = await fetch(func.functionUrl!, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(testEvent),
        });

        expect(urlResponse.status).toBe(200);

        const urlResponseBody = await urlResponse.json();
        expect(urlResponseBody.message).toBe("Hello from bundled handler!");
        expect(urlResponseBody.event).toEqual(testEvent);

        // Also invoke directly
        const directResponse = await invokeLambda(functionName, {
          direct: "invoke",
        });
        expect(directResponse.statusCode).toBe(200);
        const directBody = JSON.parse(directResponse.body);
        expect(directBody.message).toBe("Hello from bundled handler!");
        expect(directBody.event).toEqual({ direct: "invoke" });

        // Now update the function to remove the URL
        func = await Function(functionName, {
          functionName,
          zipPath: bundle.path,
          roleArn: role.arn,
          handler: "handler.handler",
          runtime: "nodejs20.x",
          tags: {
            Environment: "test",
          },
          // No URL config to remove it
        });

        // Verify URL was removed
        expect(func.functionUrl).toBeUndefined();

        // Try to invoke URL (should fail)
        let urlFailed = false;
        try {
          await fetch(func.functionUrl || "https://invalid-url", {
            method: "POST",
          });
        } catch (error) {
          urlFailed = true;
        }
        expect(urlFailed).toBe(true);

        // Direct invocation should still work
        const directResponse2 = await invokeLambda(functionName, {
          after: "update",
        });
        expect(directResponse2.statusCode).toBe(200);
        const directBody2 = JSON.parse(directResponse2.body);
        expect(directBody2.message).toBe("Hello from bundled handler!");
        expect(directBody2.event).toEqual({ after: "update" });
      } finally {
        await destroy(scope);
      }
    });

    test("create function without URL then add URL in update phase", async (scope) => {
      // Define resources that need to be cleaned up
      let role: Role | undefined = undefined;
      let bundle: Bundle | undefined = undefined;
      let func: Function | null = null;
      const functionName = `${BRANCH_PREFIX}-alchemy-test-func-add-url`;
      const roleName = `${BRANCH_PREFIX}-alchemy-test-lambda-add-url-role`;

      try {
        bundle = await Bundle(`${BRANCH_PREFIX}-test-lambda-add-url-bundle`, {
          entryPoint: path.join(__dirname, "..", "handler.ts"),
          outdir: ".out",
          format: "cjs",
          platform: "node",
          target: "node18",
        });

        role = await Role(roleName, {
          roleName,
          assumeRolePolicy: LAMBDA_ASSUME_ROLE_POLICY,
          description: "Test role for Lambda function",
          policies: [
            {
              policyName: "logs",
              policyDocument: LAMBDA_LOGS_POLICY,
            },
          ],
          tags: {
            Environment: "test",
          },
        });

        // Create the Lambda function without URL config
        func = await Function(functionName, {
          functionName,
          zipPath: bundle.path,
          roleArn: role.arn,
          handler: "handler.handler",
          runtime: "nodejs20.x",
          tags: {
            Environment: "test",
          },
          // No URL config initially
        });

        // Verify function was created without URL
        expect(func.arn).toBeTruthy();
        expect(func.state).toBe("Active");
        expect(func.functionUrl).toBeUndefined();

        // Invoke directly
        const directResponse = await invokeLambda(functionName, {
          initial: "invoke",
        });
        expect(directResponse.statusCode).toBe(200);
        const directBody = JSON.parse(directResponse.body);
        expect(directBody.message).toBe("Hello from bundled handler!");
        expect(directBody.event).toEqual({ initial: "invoke" });

        // Now update the function to add the URL
        func = await Function(functionName, {
          functionName,
          zipPath: bundle.path,
          roleArn: role.arn,
          handler: "handler.handler",
          runtime: "nodejs20.x",
          tags: {
            Environment: "test",
          },
          url: {
            authType: "NONE",
            cors: {
              allowOrigins: ["*"],
              allowMethods: ["GET", "POST"],
              allowHeaders: ["Content-Type"],
            },
          },
        });

        // Verify URL was added
        expect(func.functionUrl).toBeTruthy();
        expect(func.functionUrl).toMatch(
          /^https:\/\/.+\.lambda-url\..+\.on\.aws\/?$/
        );

        // Test function URL invocation
        const testEvent = { test: "added-url-event" };
        const urlResponse = await fetch(func.functionUrl!, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(testEvent),
        });

        expect(urlResponse.status).toBe(200);

        const urlResponseBody = await urlResponse.json();
        expect(urlResponseBody.message).toBe("Hello from bundled handler!");
        expect(urlResponseBody.event).toEqual(testEvent);

        // Direct invocation should still work
        const directResponse2 = await invokeLambda(functionName, {
          after: "url-added",
        });
        expect(directResponse2.statusCode).toBe(200);
        const directBody2 = JSON.parse(directResponse2.body);
        expect(directBody2.message).toBe("Hello from bundled handler!");
        expect(directBody2.event).toEqual({ after: "url-added" });
      } finally {
        await destroy(scope);
      }
    });
  });
});
