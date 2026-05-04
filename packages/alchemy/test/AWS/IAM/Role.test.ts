import * as AWS from "@/AWS";
import { Role } from "@/AWS/IAM";
import * as Test from "@/Test/Vitest";
import * as IAM from "@distilled.cloud/aws/iam";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

const assumeRolePolicy = {
  Version: "2012-10-17" as const,
  Statement: [
    {
      Effect: "Allow" as const,
      Principal: {
        Service: "lambda.amazonaws.com",
      },
      Action: ["sts:AssumeRole"],
    },
  ],
};

test.provider("create, update, and delete role", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const role = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Role("IamRole", {
          assumeRolePolicyDocument: assumeRolePolicy,
          managedPolicyArns: [
            "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
          ],
          inlinePolicies: {
            AllowLogs: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Action: ["logs:CreateLogGroup"],
                  Resource: "*",
                },
              ],
            },
          },
          tags: {
            env: "test",
          },
        });
      }),
    );

    const created = yield* IAM.getRole({
      RoleName: role.roleName,
    });
    expect(created.Role.RoleName).toBe(role.roleName);

    yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Role("IamRole", {
          assumeRolePolicyDocument: assumeRolePolicy,
          managedPolicyArns: [],
          inlinePolicies: {
            AllowLogs: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Action: ["logs:CreateLogStream"],
                  Resource: "*",
                },
              ],
            },
          },
          tags: {
            env: "prod",
          },
        });
      }),
    );

    const updatedTags = yield* IAM.listRoleTags({
      RoleName: role.roleName,
    });
    expect(
      Object.fromEntries(
        (updatedTags.Tags ?? []).map((tag) => [tag.Key, tag.Value]),
      ),
    ).toMatchObject({
      env: "prod",
    });

    yield* stack.destroy();

    const deleted = yield* IAM.getRole({
      RoleName: role.roleName,
    }).pipe(Effect.option);
    expect(deleted._tag).toBe("None");
  }),
);
