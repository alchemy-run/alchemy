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

const getDomain = (resourceGroupName: string, domainName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* eventgrid.GetDomain({
      subscriptionId,
      resourceGroupName,
      domainName,
    });
  });

const domainGone = (resourceGroupName: string, domainName: string) =>
  getDomain(resourceGroupName, domainName).pipe(
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

const program = (props: {
  autoTopics: boolean;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const domain = yield* Azure.EventGrid.Domain("Tenants", {
      resourceGroup: group.resourceGroupName,
      autoCreateTopicWithFirstSubscription: props.autoTopics,
      autoDeleteTopicWithLastSubscription: props.autoTopics,
      tags: props.tags,
    });
    return { group, domain };
  });

// Domains are free (first 100k operations/month); ~2 minutes.
test.provider(
  "create, update, and delete an event grid domain",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, domain } = yield* stack.deploy(
        program({ autoTopics: true, tags: { env: "test" } }),
      );
      expect(domain.domainName).toMatch(/^[A-Za-z0-9-]{3,50}$/);
      expect(domain.endpoint).toContain(".eventgrid.azure.net");
      expect(domain.primaryKey).toBeDefined();
      const observed = yield* getDomain(
        group.resourceGroupName,
        domain.domainName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.autoCreateTopicWithFirstSubscription).toEqual(
        true,
      );
      expect(observed.tags?.env).toEqual("test");

      const updated = yield* stack.deploy(
        program({ autoTopics: false, tags: { env: "prod" } }),
      );
      expect(updated.domain.domainName).toEqual(domain.domainName);
      expect(updated.domain.autoDeleteTopicWithLastSubscription).toEqual(false);
      const reobserved = yield* getDomain(
        group.resourceGroupName,
        domain.domainName,
      );
      expect(
        reobserved.properties?.autoCreateTopicWithFirstSubscription,
      ).toEqual(false);
      expect(
        reobserved.properties?.autoDeleteTopicWithLastSubscription,
      ).toEqual(false);
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* domainGone(group.resourceGroupName, domain.domainName),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:eventgrid", "live"],
    timeout: 600_000,
  },
);
