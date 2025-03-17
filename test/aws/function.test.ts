import {
  GetFunctionCommand,
  InvokeCommand,
  LambdaClient,
  ResourceNotFoundException,
} from "@aws-sdk/client-lambda";
import { describe, expect, test } from "bun:test";
import path from "node:path";
import { apply } from "../../alchemy/src/apply";
import { Function } from "../../alchemy/src/aws/function";
import type { PolicyDocument } from "../../alchemy/src/aws/policy";
import { Role } from "../../alchemy/src/aws/role";
import { destroy } from "../../alchemy/src/destroy";
import { Bundle } from "../../alchemy/src/esbuild";

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

      const role = new Role("alchemy-test-lambda-role", {
        roleName: "alchemy-test-lambda-role",
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

      const roleOutput = await apply(role);

      // Bundle the handler code
      const bundle = new Bundle("test-lambda-bundle", {
        entryPoint: path.join(__dirname, "..", "handler.ts"),
        outdir: ".out",
        format: "cjs",
        platform: "node",
        target: "node18",
      });

      const bundleOutput = await apply(bundle);

      // Create the Lambda function
      const func = new Function("alchemy-test-function", {
        functionName: "alchemy-test-function",
        zipPath: bundleOutput.path,
        roleArn: roleOutput.arn,
        handler: "handler.handler",
        runtime: "nodejs20.x",
        tags: {
          Environment: "test",
        },
      });

      const output = await apply(func);
      expect(output.id).toBe("alchemy-test-function");
      expect(output.arn).toMatch(
        /^arn:aws:lambda:[a-z0-9-]+:\d+:function:alchemy-test-function$/,
      );
      expect(output.state).toBe("Active");
      expect(output.lastUpdateStatus).toBe("Successful");
      expect(output.invokeArn).toMatch(
        /^arn:aws:apigateway:[a-z0-9-]+:lambda:path\/2015-03-31\/functions\/arn:aws:lambda:[a-z0-9-]+:\d+:function:alchemy-test-function\/invocations$/,
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
      const responsePayload = new TextDecoder().decode(invokeResponse.Payload);
      const response = JSON.parse(responsePayload);
      expect(response.statusCode).toBe(200);

      const body = JSON.parse(response.body);
      expect(body.message).toBe("Hello from bundled handler!");
      expect(body.event).toEqual(testEvent);

      // Clean up
      await destroy(func);
      await destroy(bundle);
      await destroy(role);

      await assertFunctionNotExists("alchemy-test-function");
    });
  });
});

async function assertFunctionNotExists(functionName: string) {
  await expect(
    lambda.send(
      new GetFunctionCommand({
        FunctionName: functionName,
      }),
    ),
  ).rejects.toThrow(ResourceNotFoundException);
}
