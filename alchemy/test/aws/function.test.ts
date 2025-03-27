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

const test = alchemy.test(import.meta);

const __dirname = path.dirname(new URL(import.meta.url).pathname);

const lambda = new LambdaClient({});

describe("AWS Resources", () => {
  describe("Function", () => {
    test("create function with bundled code", async (scope) => {
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
            `^arn:aws:lambda:[a-z0-9-]+:\\d+:function:${functionName}$`,
          ),
        );
        expect(func.state).toBe("Active");
        expect(func.lastUpdateStatus).toBe("Successful");
        expect(func.invokeArn).toMatch(
          new RegExp(
            `^arn:aws:apigateway:[a-z0-9-]+:lambda:path\\/2015-03-31\\/functions\\/arn:aws:lambda:[a-z0-9-]+:\\d+:function:${functionName}\\/invocations$`,
          ),
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
        await destroy(scope);

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
