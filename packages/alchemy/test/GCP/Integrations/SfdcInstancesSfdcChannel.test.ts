import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as integrations from "@distilled.cloud/gcp/integrations_v1";
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

const project = process.env.GOOGLE_PROJECT_ID ?? "";
const location = "us-central1";

const waitUntilGone = (name: string) =>
  integrations.getProjectsLocationsSfdcInstancesSfdcChannels({ name }).pipe(
    Effect.map((row) =>
      (row.deleteTime ?? "").length > 0
        ? ("gone" as const)
        : ("found" as const),
    ),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsSfdcInstancesSfdcChannels on a missing channel fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        integrations.getProjectsLocationsSfdcInstancesSfdcChannels({
          name: `projects/${project}/locations/${location}/sfdcInstances/missing/sfdcChannels/alchemy-missing-channel`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !process.env.GCP_TEST_INTEGRATIONS)(
  "create, update, and delete an SFDC channel",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const instance = yield* GCP.Integrations.SfdcInstance("Salesforce", {
            location,
            displayName: "alchemy-sfdc-channel-parent",
            description: "channel parent",
            sfdcOrgId: "00Dxx0000000001",
          });
          const channel = yield* GCP.Integrations.SfdcInstancesSfdcChannel(
            "Events",
            {
              sfdcInstance: instance.name,
              location,
              displayName: "alchemy-channel",
              description: "account events",
              channelTopic: "/event/AlchemyTest__e",
            },
          );
          return { instance, channel };
        }),
      );

      expect(created.channel.sfdcChannelId).toEqual(expect.any(String));
      expect(created.channel.location).toEqual(location);
      expect(created.channel.sfdcInstance).toEqual(created.instance.name);
      expect(created.channel.name).toEqual(
        `${created.instance.name}/sfdcChannels/${created.channel.sfdcChannelId}`,
      );
      expect(created.channel.displayName).toEqual("alchemy-channel");
      expect(created.channel.description).toEqual("account events");
      expect(created.channel.channelTopic).toEqual("/event/AlchemyTest__e");

      const fetched =
        yield* integrations.getProjectsLocationsSfdcInstancesSfdcChannels({
          name: created.channel.name,
        });
      expect(fetched.name).toEqual(created.channel.name);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.channelTopic).toEqual("/event/AlchemyTest__e");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const instance = yield* GCP.Integrations.SfdcInstance("Salesforce", {
            sfdcInstanceId: created.instance.sfdcInstanceId,
            location,
            displayName: "alchemy-sfdc-channel-parent",
            description: "channel parent",
            sfdcOrgId: "00Dxx0000000001",
          });
          const channel = yield* GCP.Integrations.SfdcInstancesSfdcChannel(
            "Events",
            {
              sfdcInstance: instance.name,
              sfdcChannelId: created.channel.sfdcChannelId,
              location,
              displayName: "alchemy-channel-v2",
              description: "account events v2",
              channelTopic: "/event/AlchemyTestV2__e",
            },
          );
          return { instance, channel };
        }),
      );

      expect(updated.channel.name).toEqual(created.channel.name);
      expect(updated.channel.displayName).toEqual("alchemy-channel-v2");
      expect(updated.channel.description).toEqual("account events v2");
      expect(updated.channel.channelTopic).toEqual("/event/AlchemyTestV2__e");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.channel.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
