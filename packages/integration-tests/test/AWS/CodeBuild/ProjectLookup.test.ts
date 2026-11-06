import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as codebuild from "@distilled.cloud/aws/codebuild";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { expectLookupConsumers } from "../lookup.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
});

const tags = ["provider:aws", "provider:aws:codebuild", "live"];

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "ProjectLookupTarget",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const role = yield* AWS.IAM.Role("lookup-target-role", {
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "codebuild.amazonaws.com" },
            Action: ["sts:AssumeRole"],
          },
        ],
      },
    });
    const project = yield* AWS.CodeBuild.Project("lookup-target", {
      serviceRole: role.roleArn,
      source: {
        type: "NO_SOURCE",
        buildspec: "version: 0.2\nphases:\n  build:\n    commands:\n      - echo ok\n",
      },
      environment: {
        type: "LINUX_CONTAINER",
        image: "aws/codebuild/amazonlinux2-x86_64-standard:5.0",
        computeType: "BUILD_GENERAL1_SMALL",
      },
      artifacts: { type: "NO_ARTIFACTS" },
    });
    return {
      projectName: project.projectName.as<string>(),
      projectArn: project.projectArn.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a looked-up project resolves by name, and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { projectName, projectArn } = yield* target;
      yield* expectLookupConsumers(
        stack,
        () => {
          return { arn: AWS.CodeBuild.Project.lookup({ projectName }).projectArn };
        },
        {
          arn: projectArn,
        },
      );
      const { projects } = yield* codebuild.batchGetProjects({ names: [projectName] });
      expect(projects?.[0]?.arn).toBe(projectArn);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a missing project fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      const lookups = {
        "missing-project": AWS.CodeBuild.Project.lookup({ projectName: name }).projectArn,
      };
      for (const [id, value] of Object.entries(lookups)) {
        yield* expectDeployFails(stack.deploy(AWS.SSM.Parameter(id, { value })), [
          "LookupNotFoundError",
        ]);
      }
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
