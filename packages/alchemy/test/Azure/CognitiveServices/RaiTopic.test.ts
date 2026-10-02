import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as cognitiveservices from "@distilled.cloud/azure/cognitiveservices";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

// Azure downloads and trains on the samples, so the URL must point at a
// real `.jsonl` blob (e.g. a SAS URL); a placeholder fails with
// "Error encountered when creating topic." (HTTP 500).
const SAMPLES = process.env.AZURE_TEST_RAI_TOPIC_SAMPLES_URL ?? "";

const program = (props: { name: string; description: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const account = yield* Azure.CognitiveServices.Account("Account", {
      resourceGroup: group.resourceGroupName,
    });
    const topic = yield* Azure.CognitiveServices.RaiTopic("Topic", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
      name: props.name,
      description: props.description,
      sampleBlobUrl: SAMPLES,
    });
    return { group, account, topic };
  });

// S0 AIServices account + custom topic (preview): $0 idle, ~1 minute plus
// asynchronous training. Needs AZURE_TEST_RAI_TOPIC_SAMPLES_URL.
test.provider.skipIf(!SAMPLES)(
  "create, update, replace, and delete a rai topic",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const subscriptionId = yield* subscription;

      const { group, account } = yield* stack.deploy(
        program({ name: "alchemy-topic-a", description: "competitors" }),
      );
      const get = (raiTopicName: string) =>
        cognitiveservices.GetRaiTopic({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          accountName: account.accountName,
          raiTopicName,
        });
      const observed = yield* get("alchemy-topic-a");
      expect(observed.properties?.description).toEqual("competitors");
      expect(observed.properties?.topicName).toEqual("alchemy-topic-a");

      // In place: description.
      yield* stack.deploy(
        program({ name: "alchemy-topic-a", description: "pricing" }),
      );
      expect((yield* get("alchemy-topic-a")).properties?.description).toEqual(
        "pricing",
      );

      // Replacement: the name is immutable.
      yield* stack.deploy(
        program({ name: "alchemy-topic-b", description: "pricing" }),
      );
      expect((yield* get("alchemy-topic-b")).properties?.description).toEqual(
        "pricing",
      );
      expect(yield* waitGone(get("alchemy-topic-a"))).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          cognitiveservices.GetAccount({
            subscriptionId,
            resourceGroupName: group.resourceGroupName,
            accountName: account.accountName,
          }),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
