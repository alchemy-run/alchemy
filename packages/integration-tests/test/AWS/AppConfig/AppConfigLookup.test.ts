import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as appconfig from "@distilled.cloud/aws/appconfig";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { expectLookupConsumers } from "../lookup.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
});

const tags = ["provider:aws", "provider:aws:appconfig", "live"];

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "AppConfigLookupTarget",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const app = yield* AWS.AppConfig.Application("lookup-target");
    const env = yield* AWS.AppConfig.Environment("lookup-target-env", {
      applicationId: app.applicationId,
    });
    const profile = yield* AWS.AppConfig.ConfigurationProfile("lookup-target-profile", {
      applicationId: app.applicationId,
    });
    return {
      applicationId: app.applicationId.as<string>(),
      applicationName: app.applicationName.as<string>(),
      environmentId: env.environmentId.as<string>(),
      environmentName: env.environmentName.as<string>(),
      profileId: profile.configurationProfileId.as<string>(),
      profileName: profile.configurationProfileName.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "applications, environments and profiles resolve by id and name, and survive destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const {
        applicationId,
        applicationName,
        environmentId,
        environmentName,
        profileId,
        profileName,
      } = yield* target;
      yield* expectLookupConsumers(
        stack,
        () => {
          return {
            byName: AWS.AppConfig.Application.lookup({ applicationName }).applicationId,
            byId: AWS.AppConfig.Application.lookup({ applicationId }).applicationName,
            environment: AWS.AppConfig.Environment.lookup({ applicationId, environmentName })
              .environmentId,
            profile: AWS.AppConfig.ConfigurationProfile.lookup({
              applicationId,
              configurationProfileName: profileName,
            }).configurationProfileId,
          };
        },
        {
          byName: applicationId,
          byId: applicationName,
          environment: environmentId,
          profile: profileId,
        },
      );
      const survivor = yield* appconfig.getApplication({ ApplicationId: applicationId });
      expect(survivor.Name).toBe(applicationName);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a missing application fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      const lookups = {
        "missing-application": AWS.AppConfig.Application.lookup({ applicationName: name })
          .applicationId,
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

test.provider(
  "a lookup of an application this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () => AWS.AppConfig.Application("lookup-managed");
      const attrs = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* AWS.SSM.Parameter("managed-application-consumer", {
              value: AWS.AppConfig.Application.lookup({ applicationId: attrs.applicationId })
                .applicationId,
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
