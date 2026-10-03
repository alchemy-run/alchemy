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

const getDomainTopic = (
  resourceGroupName: string,
  domainName: string,
  domainTopicName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* eventgrid.GetDomainTopic({
      subscriptionId,
      resourceGroupName,
      domainName,
      domainTopicName,
    });
  });

const domainTopicGone = (
  resourceGroupName: string,
  domainName: string,
  domainTopicName: string,
) =>
  getDomainTopic(resourceGroupName, domainName, domainTopicName).pipe(
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

const program = (props: { secondName?: string; withFirst: boolean }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const domain = yield* Azure.EventGrid.Domain("Tenants", {
      resourceGroup: group.resourceGroupName,
      autoCreateTopicWithFirstSubscription: false,
      autoDeleteTopicWithLastSubscription: false,
    });
    const first = props.withFirst
      ? yield* Azure.EventGrid.DomainTopic("Contoso", {
          resourceGroup: group.resourceGroupName,
          domain: domain.domainName,
        })
      : undefined;
    const second = yield* Azure.EventGrid.DomainTopic("Fabrikam", {
      resourceGroup: group.resourceGroupName,
      domain: domain.domainName,
      name: props.secondName,
    });
    return { group, domain, first, second };
  });

// Domains and domain topics are free; ~3 minutes.
test.provider(
  "create, remove, rename, and delete event grid domain topics",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, domain, first, second } = yield* stack.deploy(
        program({ withFirst: true }),
      );
      expect(first).toBeDefined();
      const firstName = first!.domainTopicName;
      expect(second.domainTopicId).toContain(
        `/domains/${domain.domainName}/topics/${second.domainTopicName}`,
      );
      const observed = yield* getDomainTopic(
        group.resourceGroupName,
        domain.domainName,
        firstName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");

      // Remove one topic.
      yield* stack.deploy(program({ withFirst: false }));
      expect(
        yield* domainTopicGone(
          group.resourceGroupName,
          domain.domainName,
          firstName,
        ),
      ).toEqual("gone");
      yield* getDomainTopic(
        group.resourceGroupName,
        domain.domainName,
        second.domainTopicName,
      );

      // Renaming replaces the topic.
      const renamed = yield* stack.deploy(
        program({ withFirst: false, secondName: "fabrikam-renamed" }),
      );
      expect(renamed.second.domainTopicName).toEqual("fabrikam-renamed");
      yield* getDomainTopic(
        group.resourceGroupName,
        domain.domainName,
        "fabrikam-renamed",
      );
      expect(
        yield* domainTopicGone(
          group.resourceGroupName,
          domain.domainName,
          second.domainTopicName,
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* domainTopicGone(
          group.resourceGroupName,
          domain.domainName,
          "fabrikam-renamed",
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:eventgrid", "live"],
    timeout: 600_000,
  },
);
