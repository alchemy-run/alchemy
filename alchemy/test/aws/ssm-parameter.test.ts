import {
  GetParameterCommand,
  ParameterNotFound,
  SSMClient,
} from "@aws-sdk/client-ssm";
import { describe, expect } from "vitest";
import { alchemy } from "../../src/alchemy.ts";
import { SSMParameter } from "../../src/aws/ssm-parameter.ts";
import { destroy } from "../../src/destroy.ts";
import { isSecret } from "../../src/secret.ts";
import { BRANCH_PREFIX } from "../util.ts";
// must import this or else alchemy.test won't exist
import "../../src/test/vitest.ts";

const client = new SSMClient({});

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

describe("SSM Parameter Resource", () => {
  // Use BRANCH_PREFIX for deterministic, non-colliding resource names
  const testId = `${BRANCH_PREFIX}-test-param`;

  test("create, update, and delete string parameter", async (scope) => {
    let parameter: SSMParameter | undefined;
    try {
      // Create a test parameter
      parameter = await SSMParameter(testId, {
        name: `/test/${testId}/config`,
        value: "initial-value",
        description: "Test parameter for CI",
        tags: {
          Environment: "test",
          Purpose: "ci-testing",
        },
      });

      expect(parameter.arn).toBeTruthy();
      expect(parameter.name).toEqual(`/test/${testId}/config`);
      expect(parameter.value).toEqual("initial-value");
      expect(parameter.type).toEqual("String");
      expect(parameter.version).toEqual(1);

      // Verify parameter was created by querying AWS directly
      const getResponse = await client.send(
        new GetParameterCommand({
          Name: `/test/${testId}/config`,
          WithDecryption: true,
        }),
      );
      expect(getResponse.Parameter?.Value).toEqual("initial-value");
      expect(getResponse.Parameter?.Type).toEqual("String");

      // Update the parameter
      parameter = await SSMParameter(testId, {
        name: `/test/${testId}/config`,
        value: "updated-value",
        description: "Updated test parameter",
        tags: {
          Environment: "test",
          Purpose: "ci-testing",
          Updated: "true",
        },
      });

      expect(parameter.value).toEqual("updated-value");
      expect(parameter.version).toBeGreaterThan(1);

      // Verify parameter was updated
      const getUpdatedResponse = await client.send(
        new GetParameterCommand({
          Name: `/test/${testId}/config`,
          WithDecryption: true,
        }),
      );
      expect(getUpdatedResponse.Parameter?.Value).toEqual("updated-value");
    } catch (err) {
      // log the error or else it's silently swallowed by destroy errors
      console.log(err);
      throw err;
    } finally {
      // Always clean up, even if test assertions fail
      await destroy(scope);

      // Verify parameter was deleted
      try {
        await client.send(
          new GetParameterCommand({
            Name: `/test/${testId}/config`,
          }),
        );
        // If we get here, the parameter wasn't deleted
        expect(false).toBe(true);
      } catch (error: any) {
        expect(error.name).toEqual(ParameterNotFound.name);
      }
    }
  });

  test("create and delete secure string parameter", async (scope) => {
    let parameter: SSMParameter | undefined;
    try {
      // Create a secure string parameter using alchemy.secret()
      parameter = await SSMParameter(`${testId}-secure`, {
        name: `/test/${testId}/secret`,
        value: alchemy.secret("super-secret-value"),
        type: "SecureString",
        description: "Test secure parameter",
        tags: {
          Environment: "test",
          Type: "secret",
        },
      });

      expect(parameter.type).toEqual("SecureString");
      expect(isSecret(parameter.value)).toBe(true);
      if (isSecret(parameter.value)) {
        expect(parameter.value.unencrypted).toEqual("super-secret-value");
      }

      // Verify parameter was created with encryption
      const getResponse = await client.send(
        new GetParameterCommand({
          Name: `/test/${testId}/secret`,
          WithDecryption: true,
        }),
      );
      expect(getResponse.Parameter?.Value).toEqual("super-secret-value");
      expect(getResponse.Parameter?.Type).toEqual("SecureString");
    } catch (err) {
      console.log(err);
      throw err;
    } finally {
      await destroy(scope);

      // Verify parameter was deleted
      try {
        await client.send(
          new GetParameterCommand({
            Name: `/test/${testId}/secret`,
          }),
        );
        expect(false).toBe(true);
      } catch (error: any) {
        expect(error.name).toEqual(ParameterNotFound.name);
      }
    }
  });

  test("create and delete string list parameter", async (scope) => {
    let parameter: SSMParameter | undefined;
    try {
      // Create a string list parameter
      parameter = await SSMParameter(`${testId}-list`, {
        name: `/test/${testId}/servers`,
        value: [
          "server1.example.com",
          "server2.example.com",
          "server3.example.com",
        ],
        type: "StringList",
        description: "Test string list parameter",
        tags: {
          Environment: "test",
          Type: "list",
        },
      });

      expect(parameter.type).toEqual("StringList");
      expect(parameter.value).toEqual([
        "server1.example.com",
        "server2.example.com",
        "server3.example.com",
      ]);

      // Verify parameter was created (AWS stores as comma-separated string)
      const getResponse = await client.send(
        new GetParameterCommand({
          Name: `/test/${testId}/servers`,
        }),
      );
      expect(getResponse.Parameter?.Value).toEqual(
        "server1.example.com,server2.example.com,server3.example.com",
      );
      expect(getResponse.Parameter?.Type).toEqual("StringList");
    } catch (err) {
      console.log(err);
      throw err;
    } finally {
      await destroy(scope);

      // Verify parameter was deleted
      try {
        await client.send(
          new GetParameterCommand({
            Name: `/test/${testId}/servers`,
          }),
        );
        expect(false).toBe(true);
      } catch (error: any) {
        expect(error.name).toEqual(ParameterNotFound.name);
      }
    }
  });
});
