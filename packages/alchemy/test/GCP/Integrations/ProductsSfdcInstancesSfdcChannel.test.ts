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

const waitUntilGone = (name: string) =>
  integrations
    .getProjectsLocationsProductsSfdcInstancesSfdcChannels({ name })
    .pipe(
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
  "getProjectsLocationsProductsSfdcInstancesSfdcChannels on a missing channel fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        integrations.getProjectsLocationsProductsSfdcInstancesSfdcChannels({
          name: `projects/${project}/locations/us-central1/products/IP/sfdcInstances/alchemy-missing/sfdcChannels/missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(
  !hasGcpCreds || !!process.env.FAST || !process.env.GCP_TEST_INTEGRATIONS,
)(
  "create, update, and delete a product Salesforce channel",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const instance = yield* GCP.Integrations.ProductsSfdcInstance(
            "ProdOrg",
            {
              location: "us-central1",
              product: "IP",
              displayName: "alchemy-channel-org",
              description: "channel parent",
              sfdcOrgId: "00D000000000002",
              serviceAuthority: "https://example.my.salesforce.com",
            },
          );
          const channel =
            yield* GCP.Integrations.ProductsSfdcInstancesSfdcChannel("Orders", {
              sfdcInstance: instance.name,
              location: "us-central1",
              product: "IP",
              displayName: "alchemy-orders",
              description: "orders channel",
              channelTopic: "/event/AlchemyOrder__e",
            });
          return { instance, channel };
        }),
      );

      expect(created.channel.name).toContain("/sfdcChannels/");
      expect(created.channel.displayName).toEqual("alchemy-orders");
      expect(created.channel.description).toEqual("orders channel");
      expect(created.channel.channelTopic).toEqual("/event/AlchemyOrder__e");

      const fetched =
        yield* integrations.getProjectsLocationsProductsSfdcInstancesSfdcChannels(
          { name: created.channel.name },
        );
      expect(fetched.name).toEqual(created.channel.name);
      expect(fetched.description).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const instance = yield* GCP.Integrations.ProductsSfdcInstance(
            "ProdOrg",
            {
              sfdcInstanceId: created.instance.sfdcInstanceId,
              location: "us-central1",
              product: "IP",
              displayName: "alchemy-channel-org",
              description: "channel parent",
              sfdcOrgId: "00D000000000002",
              serviceAuthority: "https://example.my.salesforce.com",
            },
          );
          const channel =
            yield* GCP.Integrations.ProductsSfdcInstancesSfdcChannel("Orders", {
              sfdcInstance: instance.name,
              sfdcChannelId: created.channel.sfdcChannelId,
              location: "us-central1",
              product: "IP",
              displayName: "alchemy-orders",
              description: "updated channel",
              channelTopic: "/event/AlchemyOrder__e",
            });
          return { instance, channel };
        }),
      );

      expect(updated.channel.name).toEqual(created.channel.name);
      expect(updated.channel.description).toEqual("updated channel");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.channel.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
