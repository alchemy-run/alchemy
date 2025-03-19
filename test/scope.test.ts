import { describe, expect, it } from "bun:test";
import { apply } from "../src/apply";
import type { PolicyDocument } from "../src/aws/policy";
import { Role } from "../src/aws/role";
import { destroy } from "../src/destroy";
import { File } from "../src/fs";
import { type Context, Resource } from "../src/resource";
import { Scope, getScope, rootScope, withScope } from "../src/scope";
import { BRANCH_PREFIX } from "./util";

describe("Scope", () => {
  it("should maintain scope context and track resources", async () => {
    const testScope = new Scope("test");

    await withScope(testScope, async () => {
      new File("test-file", "test.txt", "Hello World");

      const currentScope = getScope();
      expect(currentScope).toEqual(testScope);
    });
    expect(testScope.nodes.size).toBe(1);
    expect(testScope).toBe(testScope);
    expect(testScope).not.toBe(rootScope);
  });

  it("should handle nested resources with AWS Role", async () => {
    class ServiceResources extends Resource(
      "service-resources",
      async (
        ctx: Context<{ roleArn: string }>,
        props: { roleName: string },
      ) => {
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

        const role = new Role(`role`, {
          roleName: props.roleName,
          assumeRolePolicy,
        });

        return {
          roleArn: role.arn,
        };
      },
    ) {}

    const roleName = `${BRANCH_PREFIX}-alchemy-test-scope-role`;
    const service = new ServiceResources("test-service", {
      roleName,
    });

    // Apply the parent resource which should create the role
    const output = await apply(service);

    // Clean up
    await destroy(service);
  });
});
