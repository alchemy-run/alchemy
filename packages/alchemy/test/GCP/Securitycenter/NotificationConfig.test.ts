import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as scc from "@distilled.cloud/gcp/securitycenter_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

const project = process.env.GOOGLE_PROJECT_ID ?? "alchemy-gcp-testing-83661";

const waitUntilGone = (name: string) =>
  scc.getProjectsNotificationConfigs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["NotFound", "Forbidden"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsNotificationConfigs on a missing config fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        scc.getProjectsNotificationConfigs({
          name: `projects/${project}/notificationConfigs/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "create, update, and delete a notification config",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const access = yield* scc
        .listProjectsNotificationConfigs({
          parent: `projects/${project}`,
          pageSize: 1,
        })
        .pipe(
          Effect.as("ok" as const),
          Effect.catchTag(["Forbidden", "NotFound"], (error) =>
            Effect.succeed(error._tag),
          ),
        );
      if (access !== "ok") {
        expect(["Forbidden", "NotFound"]).toContain(access);
        yield* stack.destroy();
        return;
      }

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const topic = yield* GCP.PubSub.Topic("SccNotify", {});
          const config = yield* GCP.Securitycenter.NotificationConfig("High", {
            pubsubTopic: topic.name,
            description: "high severity",
            streamingConfig: { filter: 'severity="HIGH"' },
          });
          return { topic, config };
        }),
      );

      expect(created.config.configId).toEqual(expect.any(String));
      expect(created.config.name).toEqual(
        `projects/${project}/notificationConfigs/${created.config.configId}`,
      );
      expect(created.config.pubsubTopic).toEqual(created.topic.name);
      expect(created.config.description).toEqual("high severity");
      expect(created.config.streamingConfig?.filter).toEqual('severity="HIGH"');

      const fetched = yield* scc.getProjectsNotificationConfigs({
        name: created.config.name,
      });
      expect(fetched.name).toEqual(created.config.name);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.pubsubTopic).toEqual(created.topic.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const topic = yield* GCP.PubSub.Topic("SccNotify", {
            topicId: created.topic.topicId,
          });
          const config = yield* GCP.Securitycenter.NotificationConfig("High", {
            configId: created.config.configId,
            pubsubTopic: topic.name,
            description: "high and critical",
            streamingConfig: {
              filter: 'severity="HIGH" OR severity="CRITICAL"',
            },
          });
          return { topic, config };
        }),
      );

      expect(updated.config.name).toEqual(created.config.name);
      expect(updated.config.description).toEqual("high and critical");
      expect(updated.config.streamingConfig?.filter).toEqual(
        'severity="HIGH" OR severity="CRITICAL"',
      );

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.config.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
