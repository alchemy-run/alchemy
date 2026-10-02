import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as eventgrid from "@distilled.cloud/azure/eventgrid";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getConfiguration = (resourceGroupName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* eventgrid.GetPartnerConfiguration({
      subscriptionId,
      resourceGroupName,
    });
  });

const configurationGone = (resourceGroupName: string) =>
  getConfiguration(resourceGroupName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 12,
    }),
  );

const program = (props: { days: number; tags?: Record<string, string> }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const partners = yield* Azure.EventGrid.PartnerConfiguration("Partners", {
      resourceGroup: group.resourceGroupName,
      defaultMaximumExpirationTimeInDays: props.days,
      tags: props.tags,
    });
    return { group, partners };
  });

// Partner configurations are free; ~1 minute.
test.provider(
  "create, update, and delete an event grid partner configuration",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, partners } = yield* stack.deploy(program({ days: 7 }));
      expect(partners.defaultMaximumExpirationTimeInDays).toEqual(7);
      expect(partners.authorizedPartnerIds).toEqual([]);
      const observed = yield* getConfiguration(group.resourceGroupName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.["alchemy::id"]).toEqual("Partners");

      // In place: expiry and tags.
      const updated = yield* stack.deploy(
        program({ days: 30, tags: { team: "events" } }),
      );
      expect(updated.partners.partnerConfigurationId).toEqual(
        partners.partnerConfigurationId,
      );
      expect(updated.partners.tags).toEqual({ team: "events" });
      const reobserved = yield* getConfiguration(group.resourceGroupName);
      expect(
        reobserved.properties?.partnerAuthorization
          ?.defaultMaximumExpirationTimeInDays,
      ).toEqual(30);
      expect(reobserved.tags?.team).toEqual("events");

      yield* stack.destroy();
      expect(yield* configurationGone(group.resourceGroupName)).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:eventgrid", "live"],
    timeout: 600_000,
  },
);
