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

const getTopic = (resourceGroupName: string, topicName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* eventgrid.GetTopic({
      subscriptionId,
      resourceGroupName,
      topicName,
    });
  });

const topicGone = (resourceGroupName: string, topicName: string) =>
  getTopic(resourceGroupName, topicName).pipe(
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
  inputSchema: Azure.EventGrid.EventGridInputSchema;
  tags: Record<string, string>;
  inboundIpRules: Azure.EventGrid.EventGridInboundIpRule[];
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const topic = yield* Azure.EventGrid.Topic("Orders", {
      resourceGroup: group.resourceGroupName,
      inputSchema: props.inputSchema,
      inboundIpRules: props.inboundIpRules,
      tags: props.tags,
    });
    return { group, topic };
  });

// Custom topics are free (first 100k operations/month); ~2 minutes.
test.provider(
  "create, update, replace, and delete an event grid topic",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, topic } = yield* stack.deploy(
        program({
          inputSchema: "EventGridSchema",
          tags: { env: "test" },
          inboundIpRules: [],
        }),
      );
      expect(topic.topicName).toMatch(/^[A-Za-z0-9-]{3,50}$/);
      expect(topic.endpoint).toContain(".eventgrid.azure.net");
      expect(topic.inputSchema).toEqual("EventGridSchema");
      expect(topic.primaryKey).toBeDefined();
      expect(topic.tags).toEqual({ env: "test" });

      const observed = yield* getTopic(
        group.resourceGroupName,
        topic.topicName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Orders");
      expect(observed.properties?.inboundIpRules ?? []).toEqual([]);

      // In-place update: tags and inbound IP rules.
      const updated = yield* stack.deploy(
        program({
          inputSchema: "EventGridSchema",
          tags: { env: "prod" },
          inboundIpRules: [{ ipMask: "203.0.113.0/24" }],
        }),
      );
      expect(updated.topic.topicName).toEqual(topic.topicName);
      const reobserved = yield* getTopic(
        group.resourceGroupName,
        topic.topicName,
      );
      expect(reobserved.tags?.env).toEqual("prod");
      expect(reobserved.properties?.inboundIpRules).toEqual([
        { ipMask: "203.0.113.0/24", action: "Allow" },
      ]);

      // The input schema is immutable: changing it replaces the topic.
      const replaced = yield* stack.deploy(
        program({
          inputSchema: "CloudEventSchemaV1_0",
          tags: { env: "prod" },
          inboundIpRules: [{ ipMask: "203.0.113.0/24" }],
        }),
      );
      expect(replaced.topic.topicName).not.toEqual(topic.topicName);
      const replacement = yield* getTopic(
        group.resourceGroupName,
        replaced.topic.topicName,
      );
      expect(replacement.properties?.inputSchema).toEqual(
        "CloudEventSchemaV1_0",
      );
      expect(
        yield* topicGone(group.resourceGroupName, topic.topicName),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* topicGone(group.resourceGroupName, replaced.topic.topicName),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:eventgrid", "live"],
    timeout: 600_000,
  },
);
