import * as AWS from "@/AWS";
import { Project } from "@/AWS/CodeBuild/Project.ts";
import {
  normalizePolicyDocument,
  type PolicyDocument,
} from "@/AWS/IAM/Policy.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import * as codebuild from "@distilled.cloud/aws/codebuild";
import * as sts from "@distilled.cloud/aws/sts";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const projectName = "alchemy-test-codebuild-project";

const buildspec = [
  "version: 0.2",
  "phases:",
  "  build:",
  "    commands:",
  "      - echo Hello from CodeBuild",
].join("\n");

const codebuildRole = (logical: string) =>
  AWS.IAM.Role(logical, {
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
    inlinePolicies: {
      Logs: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: [
              "logs:CreateLogGroup",
              "logs:CreateLogStream",
              "logs:PutLogEvents",
            ],
            Resource: ["*"],
          },
        ],
      },
    },
  });

const getProject = codebuild
  .batchGetProjects({ names: [projectName] })
  .pipe(Effect.map((res) => res.projects?.[0]));

test.provider(
  "lifecycle: create NO_SOURCE project, update, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create — a NO_SOURCE project with an inline buildspec. Defining a
      // project is instant; no build is run.
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const role = yield* codebuildRole("ProjectRole");
          return yield* Project("LifecycleProject", {
            projectName,
            serviceRole: role.roleArn,
            source: { type: "NO_SOURCE", buildspec },
            environment: {
              image: "aws/codebuild/amazonlinux2-x86_64-standard:5.0",
              computeType: "BUILD_GENERAL1_SMALL",
              environmentVariables: [{ name: "STAGE", value: "dev" }],
            },
          });
        }),
      );
      expect(deployed.projectArn).toContain(`project/${projectName}`);

      // Out-of-band verification via distilled.
      const created = yield* getProject;
      expect(created?.name).toBe(projectName);
      expect(created?.source?.type).toBe("NO_SOURCE");
      expect(created?.environment?.computeType).toBe("BUILD_GENERAL1_SMALL");
      expect(
        created?.environment?.environmentVariables?.find(
          (v) => v.name === "STAGE",
        )?.value,
      ).toBe("dev");

      // Canonical list() coverage.
      const provider = yield* Provider.findProvider(Project);
      const all = yield* provider.list();
      expect(all.some((p) => p.projectName === projectName)).toBe(true);

      // Update — change an env var and timeout in place (no replacement),
      // and attach a typed PolicyDocument resource policy sharing the
      // project with this account's root principal.
      const identity = yield* sts.getCallerIdentity({});
      const resourcePolicy: PolicyDocument = {
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "Share",
            Effect: "Allow",
            Principal: { AWS: `arn:aws:iam::${identity.Account}:root` },
            Action: ["codebuild:BatchGetProjects"],
            Resource: deployed.projectArn,
          },
        ],
      };
      const updateProject = Effect.gen(function* () {
        const role = yield* codebuildRole("ProjectRole");
        return yield* Project("LifecycleProject", {
          projectName,
          serviceRole: role.roleArn,
          source: { type: "NO_SOURCE", buildspec },
          environment: {
            image: "aws/codebuild/amazonlinux2-x86_64-standard:5.0",
            computeType: "BUILD_GENERAL1_MEDIUM",
            environmentVariables: [{ name: "STAGE", value: "prod" }],
          },
          timeoutInMinutes: 30,
          resourcePolicy,
        });
      });
      yield* stack.deploy(updateProject);
      const updated = yield* getProject;
      expect(updated?.environment?.computeType).toBe("BUILD_GENERAL1_MEDIUM");
      expect(
        updated?.environment?.environmentVariables?.find(
          (v) => v.name === "STAGE",
        )?.value,
      ).toBe("prod");
      expect(updated?.timeoutInMinutes).toBe(30);

      // The PolicyDocument round-trips through the wire as a string that
      // normalizes back to exactly the desired document.
      const readPolicy = codebuild
        .getResourcePolicy({ resourceArn: deployed.projectArn })
        .pipe(
          Effect.map((res) => res.policy),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
      const attached = yield* readPolicy;
      expect(attached).toBeDefined();
      expect(normalizePolicyDocument(attached!)).toBe(
        normalizePolicyDocument(resourcePolicy),
      );

      // Re-deploy the identical PolicyDocument — the drift comparison is on
      // normalized documents, so this converges cleanly as a no-op and the
      // policy is unchanged.
      yield* stack.deploy(updateProject);
      const afterRedeploy = yield* readPolicy;
      expect(normalizePolicyDocument(afterRedeploy!)).toBe(
        normalizePolicyDocument(resourcePolicy),
      );

      // Drop the resourcePolicy prop — reconcile deletes the attached policy.
      yield* stack.deploy(
        Effect.gen(function* () {
          const role = yield* codebuildRole("ProjectRole");
          return yield* Project("LifecycleProject", {
            projectName,
            serviceRole: role.roleArn,
            source: { type: "NO_SOURCE", buildspec },
            environment: {
              image: "aws/codebuild/amazonlinux2-x86_64-standard:5.0",
              computeType: "BUILD_GENERAL1_MEDIUM",
              environmentVariables: [{ name: "STAGE", value: "prod" }],
            },
            timeoutInMinutes: 30,
          });
        }),
      );
      const afterRemoval = yield* readPolicy;
      expect(afterRemoval === undefined || afterRemoval === "").toBe(true);

      // Destroy — project is deleted; verify it is gone out-of-band.
      yield* stack.destroy();
      const after = yield* getProject;
      expect(after).toBeUndefined();
    }),
  { timeout: 300_000 },
);

// Running a real build provisions compute (~1-2 min); gate behind
// AWS_TEST_SLOW=1. This exercises the StartBuild + BatchGetBuilds path
// end-to-end against a NO_SOURCE project.
test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
  "slow: NO_SOURCE build runs to SUCCEEDED",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const role = yield* codebuildRole("BuildRole");
          return yield* Project("BuildProject", {
            projectName: `${projectName}-run`,
            serviceRole: role.roleArn,
            source: { type: "NO_SOURCE", buildspec },
            environment: {
              image: "aws/codebuild/amazonlinux2-x86_64-standard:5.0",
              computeType: "BUILD_GENERAL1_SMALL",
            },
          });
        }),
      );

      const started = yield* codebuild.startBuild({
        projectName: deployed.projectName,
      });
      const buildId = started.build?.id;
      expect(buildId).toBeDefined();

      // Poll until the build reaches a terminal status (bounded).
      const build = yield* codebuild.batchGetBuilds({ ids: [buildId!] }).pipe(
        Effect.map((res) => res.builds?.[0]),
        Effect.repeat({
          schedule: Schedule.spaced("10 seconds"),
          until: (b) =>
            b?.buildStatus !== undefined && b.buildStatus !== "IN_PROGRESS",
          times: 30,
        }),
      );
      expect(build?.buildStatus).toBe("SUCCEEDED");

      yield* stack.destroy();
    }),
  { timeout: 480_000 },
);
