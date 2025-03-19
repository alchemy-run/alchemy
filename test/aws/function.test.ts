import {
  GetFunctionCommand,
  InvokeCommand,
  LambdaClient,
  ResourceNotFoundException,
} from "@aws-sdk/client-lambda";
import { describe, expect, test } from "bun:test";
import path from "node:path";
import { apply } from "../../src/apply";
import { Function } from "../../src/aws/function";
import type { PolicyDocument } from "../../src/aws/policy";
import { Role } from "../../src/aws/role";
import { destroy } from "../../src/destroy";
import { Bundle } from "../../src/esbuild";
import { BRANCH_PREFIX } from "../util";

const __dirname = path.dirname(new URL(import.meta.url).pathname);

const lambda = new LambdaClient({});

describe("AWS Resources", () => {
  describe("Function", () => {
    test("create function with bundled code", async () => {
      // First create the execution role
      const assumeRolePolicy: PolicyDocument = {
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

      const logsPolicy: PolicyDocument = {
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

      // Define resources that need to be cleaned up
      const roleName = `${BRANCH_PREFIX}-alchemy-test-lambda-role`;
      const role = new Role(roleName, {
        roleName,
        assumeRolePolicy,
        description: "Test role for Lambda function",
        policies: [
          {
            policyName: "logs",
            policyDocument: logsPolicy,
          },
        ],
        tags: {
          Environment: "test",
        },
      });

      const bundleName = `${BRANCH_PREFIX}-test-lambda-bundle`;
      const bundle = new Bundle(bundleName, {
        entryPoint: path.join(__dirname, "..", "handler.ts"),
        outdir: ".out",
        format: "cjs",
        platform: "node",
        target: "node18",
      });

      const functionName = `${BRANCH_PREFIX}-alchemy-test-function`;
      let func: Function | null = null;

      try {
        // Apply the role first
        const roleOutput = await apply(role);

        // Bundle the handler code
        const bundleOutput = await apply(bundle);

        // Create the Lambda function
        func = new Function(functionName, {
          functionName,
          zipPath: bundleOutput.path,
          roleArn: roleOutput.arn,
          handler: "handler.handler",
          runtime: "nodejs20.x",
          tags: {
            Environment: "test",
          },
        });

        const output = await apply(func);
        expect(output.id).toBe(functionName);
        expect(output.arn).toMatch(
          new RegExp(
            `^arn:aws:lambda:[a-z0-9-]+:\\d+:function:${functionName}$`,
          ),
        );
        expect(output.state).toBe("Active");
        expect(output.lastUpdateStatus).toBe("Successful");
        expect(output.invokeArn).toMatch(
          new RegExp(
            `^arn:aws:apigateway:[a-z0-9-]+:lambda:path\\/2015-03-31\\/functions\\/arn:aws:lambda:[a-z0-9-]+:\\d+:function:${functionName}\\/invocations$`,
          ),
        );

        // Immediately apply again to test stabilization logic
        const secondOutput = await apply(func);
        expect(secondOutput.state).toBe("Active");
        expect(secondOutput.lastUpdateStatus).toBe("Successful");

        // Invoke the function
        const testEvent = { test: "event" };
        const invokeResponse = await lambda.send(
          new InvokeCommand({
            FunctionName: output.functionName,
            Payload: JSON.stringify(testEvent),
          }),
        );

        // Parse the response
        const responsePayload = new TextDecoder().decode(
          invokeResponse.Payload,
        );
        const response = JSON.parse(responsePayload);
        expect(response.statusCode).toBe(200);

        const body = JSON.parse(response.body);
        expect(body.message).toBe("Hello from bundled handler!");
        expect(body.event).toEqual(testEvent);
      } finally {
        // Clean up resources in reverse order of creation
        if (func) {
          await destroy(func).catch((e) =>
            console.error("Error cleaning up function:", e),
          );
        }
        await destroy(bundle).catch((e) =>
          console.error("Error cleaning up bundle:", e),
        );
        await destroy(role).catch((e) =>
          console.error("Error cleaning up role:", e),
        );

        // Verify function was properly deleted after cleanup
        if (func) {
          await expect(
            lambda.send(
              new GetFunctionCommand({
                FunctionName: functionName,
              }),
            ),
          ).rejects.toThrow(ResourceNotFoundException);
        }
      }
    });
  });
});
