import {
  GetRoleCommand,
  IAMClient,
  ListAttachedRolePoliciesCommand,
  NoSuchEntityException,
} from "@aws-sdk/client-iam";
import { describe, expect } from "vitest";
import { alchemy } from "../../src/alchemy.js";
import type { PolicyDocument } from "../../src/aws/policy.js";
import { Role, type RoleProps } from "../../src/aws/role.js";
import { destroy } from "../../src/destroy.js";
import { BRANCH_PREFIX } from "../util.js";

import "../../src/test/vitest.js";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

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

    test("create role simple", async (scope) => {
      const role = await Role(`${BRANCH_PREFIX}-test-create-role`, {
        roleName: `${BRANCH_PREFIX}-test-create-role`,
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

      try {
        expect(role.roleName).toBe(`${BRANCH_PREFIX}-test-create-role`);
        expect(role.arn).toMatch(
          new RegExp(
            `^arn:aws:iam::\\d+:role/${BRANCH_PREFIX.replace(/\//g, "\\/")}-test-create-role$`,
          ),
        );
        expect(role.uniqueId).toBeTruthy();
        expect(role.roleId).toBeTruthy();
        expect(role.createDate).toBeInstanceOf(Date);
      } finally {
        await destroy(scope);
        await assertRoleNotExists(`${BRANCH_PREFIX}-test-create-role`);
      }
    });

    test("update role", async (scope) => {
      const roleProps: RoleProps = {
        roleName: `${BRANCH_PREFIX}-test-update-role`,
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
      let role = await Role(`${BRANCH_PREFIX}-test-update-role`, roleProps);

      try {
        expect(role.roleName).toBe(`${BRANCH_PREFIX}-test-update-role`);
        expect(role.description).toBe("Updated test role for IAC");
        expect(role.maxSessionDuration).toBe(7200);
        expect(role.tags).toEqual({
          Environment: "test",
          Updated: "true",
        });

        role = await Role(`${BRANCH_PREFIX}-test-update-role`, {
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

        expect(role.description).toBe("Updated test role for IAC");
        expect(role.policies).toEqual([
          {
            policyName: "logs",
            policyDocument: inlinePolicy,
          },
        ]);
      } finally {
        await destroy(scope);
        await assertRoleNotExists(`${BRANCH_PREFIX}-test-update-role`);
      }
    });

    test("create role with managed policies", async (scope) => {
      const managedPolicyArn = "arn:aws:iam::aws:policy/ReadOnlyAccess";
      const roleId = `${BRANCH_PREFIX}-test-managed-policy-role`;
      const roleName = `${BRANCH_PREFIX}-test-managed-policy-role`;

      // Create an initial role
      let role;
      try {
        role = await Role(roleId, {
          roleName,
          assumeRolePolicy,
          description: "Test role with managed policies",
          tags: {
            Environment: "test",
          },
          managedPolicyArns: [managedPolicyArn],
        });
        expect(role.roleName).toBe(roleName);
        expect(role.arn).toMatch(
          new RegExp(
            `^arn:aws:iam::\\d+:role/${BRANCH_PREFIX.replace(/\//g, "\\/")}-test-managed-policy-role$`,
          ),
        );

        // Verify managed policy is attached
        const attachedPoliciesResponse = await iam.send(
          new ListAttachedRolePoliciesCommand({
            RoleName: roleName,
          }),
        );

        expect(attachedPoliciesResponse.AttachedPolicies).toBeTruthy();
        expect(attachedPoliciesResponse.AttachedPolicies?.length).toBe(1);
        expect(attachedPoliciesResponse.AttachedPolicies?.[0].PolicyArn).toBe(
          managedPolicyArn,
        );
      } finally {
        await destroy(scope);
        // Wait for the role to be deleted before continuing
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      // Now test updating with a different policy
      const updatedPolicyArn = "arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess";

      try {
        role = await Role(roleId, {
          roleName,
          assumeRolePolicy,
          description: "Test role with updated managed policies",
          tags: {
            Environment: "test",
          },
          managedPolicyArns: [updatedPolicyArn],
        });

        // Verify the updated managed policy is attached
        const updatedPolicies = await iam.send(
          new ListAttachedRolePoliciesCommand({
            RoleName: roleName,
          }),
        );

        expect(updatedPolicies.AttachedPolicies).toBeTruthy();
        expect(updatedPolicies.AttachedPolicies?.length).toBe(1);
        expect(updatedPolicies.AttachedPolicies?.[0].PolicyArn).toBe(
          updatedPolicyArn,
        );
      } finally {
        await destroy(scope);
        // Wait for the role to be deleted before asserting
        await new Promise((resolve) => setTimeout(resolve, 2000));
        await assertRoleNotExists(roleName);
      }
    });

    test("remove managed policies when not specified in update", async (scope) => {
      const managedPolicyArn = "arn:aws:iam::aws:policy/ReadOnlyAccess";
      const roleName = `${BRANCH_PREFIX}-test-remove-policies-role`;

      let role;
      // Create role with managed policy
      try {
        role = await Role(`${BRANCH_PREFIX}-test-remove-policies`, {
          roleName,
          assumeRolePolicy,
          description: "Test role with managed policies",
          tags: {
            Environment: "test",
          },
          managedPolicyArns: [managedPolicyArn],
        });

        expect(role.roleName).toBe(roleName);

        // Verify managed policy is attached
        let attachedPolicies = await iam.send(
          new ListAttachedRolePoliciesCommand({
            RoleName: roleName,
          }),
        );

        expect(attachedPolicies.AttachedPolicies).toBeTruthy();
        expect(attachedPolicies.AttachedPolicies?.length).toBe(1);
        expect(attachedPolicies.AttachedPolicies?.[0].PolicyArn).toBe(
          managedPolicyArn,
        );

        // Update role WITHOUT specifying managedPolicyArns (undefined)
        role = await Role(`${BRANCH_PREFIX}-test-remove-policies`, {
          roleName,
          assumeRolePolicy,
          description: "Test role with managed policies removed",
          tags: {
            Environment: "test",
          },
          // No managedPolicyArns specified
        });

        // Verify managed policies have been removed
        attachedPolicies = await iam.send(
          new ListAttachedRolePoliciesCommand({
            RoleName: roleName,
          }),
        );

        expect(attachedPolicies.AttachedPolicies).toBeTruthy();
        expect(attachedPolicies.AttachedPolicies?.length).toBe(0);
      } finally {
        await destroy(scope);
      }

      await assertRoleNotExists(roleName);
    });
  });
});

async function assertRoleNotExists(roleName: string) {
  await expect(
    iam.send(
      new GetRoleCommand({
        RoleName: roleName,
      }),
    ),
  ).rejects.toThrow(NoSuchEntityException);
}
