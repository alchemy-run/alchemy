import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as cognitiveservices from "@distilled.cloud/azure/cognitiveservices";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: { name: string; pattern: string; isRegex: boolean }) =>
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
    });
    const item = yield* Azure.CognitiveServices.RaiBlocklistItem("Item", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
      raiBlocklist: blocklist.raiBlocklistName,
      name: props.name,
      pattern: props.pattern,
      isRegex: props.isRegex,
    });
    return { group, account, blocklist, item };
  });

// S0 AIServices account + blocklist + item: $0 idle, ~1 minute.
test.provider(
  "create, update, replace, and delete a rai blocklist item",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const subscriptionId = yield* subscription;

      const { group, account, blocklist, item } = yield* stack.deploy(
        program({
          name: "alchemy-item-a",
          pattern: "top secret",
          isRegex: false,
        }),
      );
      // GET on a single item answers HTTP 400 even when it exists, so
      // observe items through the blocklist's item list.
      const list = cognitiveservices.ListRaiBlocklistItems({
        subscriptionId,
        resourceGroupName: group.resourceGroupName,
        accountName: account.accountName,
        raiBlocklistName: blocklist.raiBlocklistName,
      });
      const get = (name: string) =>
        list.pipe(
          Effect.map((page) => page.value?.find((i) => i.name === name)),
        );
      const gone = (name: string) =>
        get(name).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("5 seconds"),
            until: (found) => found === undefined,
            times: 12,
          }),
          Effect.map((found) => (found === undefined ? "gone" : "found")),
        );
      expect(item.pattern).toEqual("top secret");
      const observed = yield* get("alchemy-item-a");
      expect(observed?.properties?.pattern).toEqual("top secret");
      expect(observed?.properties?.isRegex).toEqual(false);

      // In place: pattern becomes a regex.
      yield* stack.deploy(
        program({
          name: "alchemy-item-a",
          pattern: "project-[a-z]+",
          isRegex: true,
        }),
      );
      const reobserved = yield* get("alchemy-item-a");
      expect(reobserved?.properties?.pattern).toEqual("project-[a-z]+");
      expect(reobserved?.properties?.isRegex).toEqual(true);

      // Replacement: the name is immutable.
      yield* stack.deploy(
        program({
          name: "alchemy-item-b",
          pattern: "project-[a-z]+",
          isRegex: true,
        }),
      );
      expect((yield* get("alchemy-item-b"))?.properties?.isRegex).toEqual(true);
      expect(yield* gone("alchemy-item-a")).toEqual("gone");

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
