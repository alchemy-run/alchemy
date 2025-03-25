import { describe, expect, it } from "bun:test";
import { alchemy } from "../src/alchemy";
import type { PolicyDocument } from "../src/aws/policy";
import { Role } from "../src/aws/role";
import type { Context } from "../src/context";
import { destroy } from "../src/destroy";
import { File } from "../src/fs";
import { Resource } from "../src/resource";
import { Scope } from "../src/scope";
import { BRANCH_PREFIX } from "./util";

describe("Scope", () => {
  it("should maintain scope context and track resources", async () => {
    let file: File | undefined = undefined;
    try {
      await alchemy.run(async (scope) => {
        file = await File("test-file", {
          path: "test.txt",
          content: "Hello World",
        });
        expect(Scope.current).toEqual(scope);
        expect(scope.resources.size).toBe(1);
        expect(scope).toBe(scope);

        return file;
      });
    } finally {
      if (file) {
        await destroy(file);
      }
    }
  });

  it("should handle nested resources with AWS Role", async () => {
    interface ServiceResources extends Resource<"service-resources"> {
      roleName: string;
    }
    const ServiceResources = Resource(
      "service-resources",
      async function (
        this: Context<ServiceResources> | void,
        id: string,
        props: {
          roleName: string;
        },
      ) {
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

        const role = await Role(`role`, {
          roleName: props.roleName,
          assumeRolePolicy,
        });

        return {
          kind: "service-resources",
          roleArn: role.arn,
        };
      },
    );

    const roleName = `${BRANCH_PREFIX}-alchemy-test-scope-role`;
    const service = await ServiceResources("test-service", {
      roleName,
    });

    // Clean up
    await destroy(service);
  });
});
