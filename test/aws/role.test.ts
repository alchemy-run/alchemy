import {
  GetRoleCommand,
  IAMClient,
  NoSuchEntityException,
} from "@aws-sdk/client-iam";
import { describe, expect, test } from "bun:test";
import { apply } from "../../alchemy/src/apply";
import type { PolicyDocument } from "../../alchemy/src/aws/policy";
import { Role, type RoleProps } from "../../alchemy/src/aws/role";
import { destroy } from "../../alchemy/src/destroy";

// Verify role was deleted
const iam = new IAMClient({});

describe("AWS Resources", () => {
  describe("Role", () => {
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

    const inlinePolicy: PolicyDocument = {
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

    test("create role", async () => {
      const role = new Role("alchemy-test-create-role", {
        roleName: "alchemy-test-create-role",
        assumeRolePolicy,
        description: "Test role for IAC",
        tags: {
          Environment: "test",
        },
        policies: [
          {
            policyName: "logs",
            policyDocument: inlinePolicy,
          },
        ],
      });

      const output = await apply(role);
      expect(output.id).toBe("alchemy-test-create-role");
      expect(output.arn).toMatch(
        /^arn:aws:iam::\d+:role\/alchemy-test-create-role$/,
      );
      expect(output.uniqueId).toBeTruthy();
      expect(output.roleId).toBeTruthy();
      expect(output.createDate).toBeInstanceOf(Date);

      await destroy(role);

      await assertRoleNotExists("alchemy-test-create-role");
    });

    test("update role", async () => {
      const roleProps: RoleProps = {
        roleName: "alchemy-test-update-role",
        assumeRolePolicy,
        description: "Updated test role for IAC",
        maxSessionDuration: 7200,
        tags: {
          Environment: "test",
          Updated: "true",
        },
        policies: [
          {
            policyName: "logs",
            policyDocument: inlinePolicy,
          },
          {
            policyName: "extra",
            policyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Action: "s3:ListBucket",
                  Resource: "*",
                },
              ],
            },
          },
        ],
      };
      let role = new Role("alchemy-test-update-role", roleProps);

      let output = await apply(role);
      expect(output.id).toBe("alchemy-test-update-role");
      expect(output.description).toBe("Updated test role for IAC");
      expect(output.maxSessionDuration).toBe(7200);
      expect(output.tags).toEqual({
        Environment: "test",
        Updated: "true",
      });

      role = new Role("alchemy-test-update-role", {
        ...roleProps,
        description: "Updated test role for IAC",
        policies: [
          {
            policyName: "logs",
            policyDocument: inlinePolicy,
          },
          // 1 policy removed
        ],
      });

      output = await apply(role);

      expect(output.description).toBe("Updated test role for IAC");
      expect(output.policies).toEqual([
        {
          policyName: "logs",
          policyDocument: inlinePolicy,
        },
      ]);

      await destroy(role);

      await assertRoleNotExists("alchemy-test-update-role");
    });
  });
});

async function assertRoleNotExists(roleName: string) {
  await expect(
    iam.send(
      new GetRoleCommand({
        RoleName: "alchemy-test-create-role",
      }),
    ),
  ).rejects.toThrow(NoSuchEntityException);
}
