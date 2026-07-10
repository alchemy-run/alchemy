import * as AWS from "@/AWS";
import { Application } from "@/AWS/CodeDeploy/Application.ts";
import { DeploymentGroup } from "@/AWS/CodeDeploy/DeploymentGroup.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import * as codedeploy from "@distilled.cloud/aws/codedeploy";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

const applicationName = "alchemy-test-cd-app";
const deploymentGroupName = "alchemy-test-cd-dg";

const getGroup = codedeploy
  .getDeploymentGroup({ applicationName, deploymentGroupName })
  .pipe(
    Effect.map((res) => res.deploymentGroupInfo),
    Effect.catchTag(
      [
        "DeploymentGroupDoesNotExistException",
        "ApplicationDoesNotExistException",
      ],
      () => Effect.succeed(undefined),
    ),
  );

// A Lambda-platform deployment group: an application, a CodeDeploy service role
// (assumed by codedeploy.amazonaws.com, granted the AWS-managed Lambda policy),
// and the group tying a deployment config to the application.
const makeStack = (deploymentConfigName: string) =>
  Effect.gen(function* () {
    const app = yield* Application("App", {
      applicationName,
      computePlatform: "Lambda",
    });
    const role = yield* AWS.IAM.Role("DeployRole", {
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "codedeploy.amazonaws.com" },
            Action: ["sts:AssumeRole"],
          },
        ],
      },
      managedPolicyArns: [
        "arn:aws:iam::aws:policy/service-role/AWSCodeDeployRoleForLambda",
      ],
    });
    const group = yield* DeploymentGroup("Group", {
      applicationName: app.applicationName,
      deploymentGroupName,
      serviceRoleArn: role.roleArn,
      deploymentConfigName,
      deploymentStyle: {
        deploymentType: "BLUE_GREEN",
        deploymentOption: "WITH_TRAFFIC_CONTROL",
      },
      autoRollbackConfiguration: {
        enabled: true,
        events: ["DEPLOYMENT_FAILURE"],
      },
      tags: { env: "test" },
    });
    return { app, group };
  });

test.provider(
  "lifecycle: create Lambda application + deployment group, update config, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create.
      const deployed = yield* stack.deploy(
        makeStack("CodeDeployDefault.LambdaAllAtOnce"),
      );
      expect(deployed.app.applicationName).toBe(applicationName);
      expect(deployed.app.applicationArn).toContain(":application:");
      expect(deployed.app.computePlatform).toBe("Lambda");
      expect(deployed.group.deploymentGroupName).toBe(deploymentGroupName);
      expect(deployed.group.deploymentGroupArn).toContain(":deploymentgroup:");

      // Out-of-band verification via distilled.
      const created = yield* getGroup;
      expect(created?.deploymentGroupName).toBe(deploymentGroupName);
      expect(created?.computePlatform).toBe("Lambda");
      expect(created?.deploymentConfigName).toBe(
        "CodeDeployDefault.LambdaAllAtOnce",
      );

      const appCheck = yield* codedeploy.getApplication({ applicationName });
      expect(appCheck.application?.computePlatform).toBe("Lambda");

      // Canonical list() coverage for Application.
      const appProvider = yield* Provider.findProvider(Application);
      const apps = yield* appProvider.list();
      expect(apps.some((a) => a.applicationName === applicationName)).toBe(
        true,
      );

      // Update — change the deployment config in place (no replacement).
      yield* stack.deploy(
        makeStack("CodeDeployDefault.LambdaCanary10Percent5Minutes"),
      );
      const updated = yield* getGroup;
      expect(updated?.deploymentConfigName).toBe(
        "CodeDeployDefault.LambdaCanary10Percent5Minutes",
      );

      // Destroy — verify the group and application are gone out-of-band.
      yield* stack.destroy();
      const afterGroup = yield* getGroup;
      expect(afterGroup).toBeUndefined();
      const afterApp = yield* codedeploy
        .getApplication({ applicationName })
        .pipe(
          Effect.map((res) => res.application),
          Effect.catchTag("ApplicationDoesNotExistException", () =>
            Effect.succeed(undefined),
          ),
        );
      expect(afterApp).toBeUndefined();
    }),
  { timeout: 300_000 },
);
