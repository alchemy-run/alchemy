import * as AWS from "@/AWS";
import * as AppConfig from "@/AWS/AppConfig";
import * as Test from "@/Test/Vitest";
import * as appconfig from "@distilled.cloud/aws/appconfig";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: AWS.providers() });

const getApp = (applicationId: string) =>
  appconfig
    .getApplication({ ApplicationId: applicationId })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );

const waitUntilAppGone = (applicationId: string) =>
  getApp(applicationId).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (a) => a === undefined,
      times: 10,
    }),
  );

// Full AppConfig control-plane lifecycle in one stack: application ->
// environment -> hosted configuration profile -> hosted version, plus a
// standalone deployment strategy. Everything is fast and free. Update the
// application description in place, then destroy and verify out-of-band.
test.provider(
  "appconfig control plane: create the full chain, update, and destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = (description: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const app = yield* AppConfig.Application("App", {
              description,
              tags: { team: "platform" },
            });
            const env = yield* AppConfig.Environment("Env", {
              applicationId: app.applicationId,
            });
            const profile = yield* AppConfig.ConfigurationProfile("Profile", {
              applicationId: app.applicationId,
              locationUri: "hosted",
            });
            const version = yield* AppConfig.HostedConfigurationVersion("V1", {
              applicationId: app.applicationId,
              configurationProfileId: profile.configurationProfileId,
              content: JSON.stringify({ featureX: true }),
              contentType: "application/json",
            });
            const strategy = yield* AppConfig.DeploymentStrategy("Strategy", {
              deploymentDurationInMinutes: 0,
              growthFactor: 100,
              finalBakeTimeInMinutes: 0,
              replicateTo: "NONE",
            });
            return {
              applicationId: app.applicationId.as<string>(),
              applicationArn: app.applicationArn.as<string>(),
              environmentId: env.environmentId.as<string>(),
              configurationProfileId:
                profile.configurationProfileId.as<string>(),
              versionNumber: version.versionNumber.as<number>(),
              strategyId: strategy.deploymentStrategyId.as<string>(),
            };
          }),
        );

      const created = yield* deploy("v1 description");
      expect(created.applicationId).toBeTruthy();
      expect(created.environmentId).toBeTruthy();
      expect(created.configurationProfileId).toBeTruthy();
      expect(created.versionNumber).toBe(1);
      expect(created.strategyId).toBeTruthy();

      // Out-of-band: the application exists and carries alchemy + user tags.
      const app = yield* getApp(created.applicationId);
      expect(app?.Description).toBe("v1 description");
      const tags = yield* appconfig.listTagsForResource({
        ResourceArn: created.applicationArn,
      });
      expect(tags.Tags?.["alchemy::id"]).toBe("App");
      expect(tags.Tags?.team).toBe("platform");

      // Out-of-band: the hosted version content round-trips.
      const version = yield* appconfig.getHostedConfigurationVersion({
        ApplicationId: created.applicationId,
        ConfigurationProfileId: created.configurationProfileId,
        VersionNumber: created.versionNumber,
      });
      const content = yield* Stream.mkString(
        Stream.decodeText(version.Content!),
      );
      expect(JSON.parse(content)).toEqual({ featureX: true });

      // Update the description in place — the application id is stable.
      const updated = yield* deploy("v2 description");
      expect(updated.applicationId).toBe(created.applicationId);
      const appAfter = yield* getApp(created.applicationId);
      expect(appAfter?.Description).toBe("v2 description");

      // Destroy — the application (and its children) are gone.
      yield* stack.destroy();
      const gone = yield* waitUntilAppGone(created.applicationId);
      expect(gone).toBeUndefined();
    }),
  { timeout: 240_000 },
);
