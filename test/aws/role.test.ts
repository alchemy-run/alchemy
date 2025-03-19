import {
  GetRoleCommand,
  IAMClient,
  ListAttachedRolePoliciesCommand,
  NoSuchEntityException,
} from "@aws-sdk/client-iam";
import { describe, expect, test } from "bun:test";
import { apply } from "../../src/apply";
import type { PolicyDocument } from "../../src/aws/policy";
import { Role, type RoleProps } from "../../src/aws/role";
import { destroy } from "../../src/destroy";
import { BRANCH_PREFIX } from "../util";

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
      const role = new Role(`${BRANCH_PREFIX}-test-create-role`, {
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
        const output = await apply(role);
        expect(output.id).toBe(`${BRANCH_PREFIX}-test-create-role`);
        expect(output.arn).toMatch(
          new RegExp(
            `^arn:aws:iam::\\d+:role/${BRANCH_PREFIX.replace(/\//g, "\\/")}-test-create-role$`,
          ),
        );
        expect(output.uniqueId).toBeTruthy();
        expect(output.roleId).toBeTruthy();
        expect(output.createDate).toBeInstanceOf(Date);
      } finally {
        await destroy(role);
        await assertRoleNotExists(`${BRANCH_PREFIX}-test-create-role`);
      }
    });

    test("update role", async () => {
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
      let role = new Role(`${BRANCH_PREFIX}-test-update-role`, roleProps);

      try {
        let output = await apply(role);
        expect(output.id).toBe(`${BRANCH_PREFIX}-test-update-role`);
        expect(output.description).toBe("Updated test role for IAC");
        expect(output.maxSessionDuration).toBe(7200);
        expect(output.tags).toEqual({
          Environment: "test",
          Updated: "true",
        });

        role = new Role(`${BRANCH_PREFIX}-test-update-role`, {
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
      } finally {
        await destroy(role);
        await assertRoleNotExists(`${BRANCH_PREFIX}-test-update-role`);
      }
    });

    test("create role with managed policies", async () => {
      const managedPolicyArn = "arn:aws:iam::aws:policy/ReadOnlyAccess";
      const roleId = `${BRANCH_PREFIX}-test-managed-policy-role`;
      const roleName = `${BRANCH_PREFIX}-test-managed-policy-role`;

      // Create an initial role
      const role = new Role(roleId, {
        roleName,
        assumeRolePolicy,
        description: "Test role with managed policies",
        tags: {
          Environment: "test",
        },
        managedPolicyArns: [managedPolicyArn],
      });

      try {
        const output = await apply(role);
        expect(output.id).toBe(roleName);
        expect(output.arn).toMatch(
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
        await destroy(role);
        // Wait for the role to be deleted before continuing
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      // Now test updating with a different policy
      const updatedPolicyArn = "arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess";
      const updatedRole = new Role(roleId, {
        roleName,
        assumeRolePolicy,
        description: "Test role with updated managed policies",
        tags: {
          Environment: "test",
        },
        managedPolicyArns: [updatedPolicyArn],
      });

      try {
        const updatedOutput = await apply(updatedRole);

        // Verify the updated managed policy is attached
        const updatedPoliciesResponse = await iam.send(
          new ListAttachedRolePoliciesCommand({
            RoleName: roleName,
          }),
        );

        expect(updatedPoliciesResponse.AttachedPolicies).toBeTruthy();
        expect(updatedPoliciesResponse.AttachedPolicies?.length).toBe(1);
        expect(updatedPoliciesResponse.AttachedPolicies?.[0].PolicyArn).toBe(
          updatedPolicyArn,
        );
      } finally {
        await destroy(updatedRole);
        // Wait for the role to be deleted before asserting
        await new Promise((resolve) => setTimeout(resolve, 2000));
        await assertRoleNotExists(roleName);
      }
    }, 15000); // Set timeout to 15 seconds

    test("remove managed policies when not specified in update", async () => {
      const managedPolicyArn = "arn:aws:iam::aws:policy/ReadOnlyAccess";
      const roleName = `${BRANCH_PREFIX}-test-remove-policies-role`;

      // Create role with managed policy
      const role = new Role(`${BRANCH_PREFIX}-test-remove-policies`, {
        roleName,
        assumeRolePolicy,
        description: "Test role with managed policies",
        tags: {
          Environment: "test",
        },
        managedPolicyArns: [managedPolicyArn],
      });

      try {
        const output = await apply(role);
        expect(output.id).toBe(roleName);

        // Verify managed policy is attached
        let attachedPoliciesResponse = await iam.send(
          new ListAttachedRolePoliciesCommand({
            RoleName: roleName,
          }),
        );

        expect(attachedPoliciesResponse.AttachedPolicies).toBeTruthy();
        expect(attachedPoliciesResponse.AttachedPolicies?.length).toBe(1);
        expect(attachedPoliciesResponse.AttachedPolicies?.[0].PolicyArn).toBe(
          managedPolicyArn,
        );

        // Update role WITHOUT specifying managedPolicyArns (undefined)
        const updatedRole = new Role(`${BRANCH_PREFIX}-test-remove-policies`, {
          roleName,
          assumeRolePolicy,
          description: "Test role with managed policies removed",
          tags: {
            Environment: "test",
          },
          // No managedPolicyArns specified
        });

        try {
          await apply(updatedRole);

          // Verify managed policies have been removed
          attachedPoliciesResponse = await iam.send(
            new ListAttachedRolePoliciesCommand({
              RoleName: roleName,
            }),
          );

          expect(attachedPoliciesResponse.AttachedPolicies).toBeTruthy();
          expect(attachedPoliciesResponse.AttachedPolicies?.length).toBe(0);
        } finally {
          await destroy(updatedRole);
        }
      } catch (error) {
        // Make sure to clean up even if the test fails
        await destroy(role);
        throw error;
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
