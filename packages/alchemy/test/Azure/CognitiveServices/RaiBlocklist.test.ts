import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as cognitiveservices from "@distilled.cloud/azure/cognitiveservices";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: {
  name: string;
  description: string;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const account = yield* Azure.CognitiveServices.Account("Account", {
      resourceGroup: group.resourceGroupName,
    });
    const blocklist = yield* Azure.CognitiveServices.RaiBlocklist("Blocklist", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
      name: props.name,
      description: props.description,
      tags: props.tags,
    });
    return { group, account, blocklist };
  });

// S0 AIServices account + blocklist: $0 idle, ~1 minute.
test.provider(
  "create, update, replace, and delete a rai blocklist",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const subscriptionId = yield* subscription;

      const { group, account, blocklist } = yield* stack.deploy(
        program({
          name: "alchemy-list-a",
          description: "one",
          tags: { env: "test" },
        }),
      );
      const get = (raiBlocklistName: string) =>
        cognitiveservices.GetRaiBlocklist({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          accountName: account.accountName,
          raiBlocklistName,
        });
      expect(blocklist.raiBlocklistName).toEqual("alchemy-list-a");
      const observed = yield* get("alchemy-list-a");
      expect(observed.properties?.description).toEqual("one");
      expect(observed.tags?.env).toEqual("test");

      // In place: description and tags.
      yield* stack.deploy(
        program({
          name: "alchemy-list-a",
          description: "two",
          tags: { env: "prod" },
        }),
      );
      const reobserved = yield* get("alchemy-list-a");
      expect(reobserved.properties?.description).toEqual("two");
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: the name is immutable.
      yield* stack.deploy(
        program({
          name: "alchemy-list-b",
          description: "two",
          tags: { env: "prod" },
        }),
      );
      expect((yield* get("alchemy-list-b")).properties?.description).toEqual(
        "two",
      );
      expect(yield* waitGone(get("alchemy-list-a"))).toEqual("gone");

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
