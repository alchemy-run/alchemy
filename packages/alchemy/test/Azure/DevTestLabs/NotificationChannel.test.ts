import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as devtestlabs from "@distilled.cloud/azure/devtestlabs";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { labFixture, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getChannel = (resourceGroupName: string, labName: string, name: string) =>
  Effect.gen(function* () {
    return yield* devtestlabs.GetNotificationChannel({
      subscriptionId: yield* subscription,
      resourceGroupName,
      labName,
      name,
    });
  });

const program = (props: { description: string; name?: string }) =>
  Effect.gen(function* () {
    const { group, lab } = yield* labFixture();
    const channel = yield* Azure.DevTestLabs.NotificationChannel("Ops", {
      resourceGroup: group.resourceGroupName,
      lab: lab.labName,
      name: props.name,
      events: ["AutoShutdown"],
      emailRecipient: "ops@example.com",
      notificationLocale: "en",
      description: props.description,
    });
    return { group, lab, channel };
  });

// Free lab + channel; ~5 minutes for the lab.
test.provider(
  "create, update, replace, and delete a notification channel",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, lab, channel } = yield* stack.deploy(
        program({ description: "first" }),
      );
      const get = (name: string) =>
        getChannel(group.resourceGroupName, lab.labName, name);
      const observed = yield* get(channel.notificationChannelName);
      expect(observed.properties?.emailRecipient).toEqual("ops@example.com");
      expect(observed.properties?.description).toEqual("first");
      expect(channel.events).toEqual(["AutoShutdown"]);

      // In-place: description.
      const updated = yield* stack.deploy(program({ description: "second" }));
      expect(updated.channel.notificationChannelId).toEqual(
        channel.notificationChannelId,
      );
      expect(
        (yield* get(channel.notificationChannelName)).properties?.description,
      ).toEqual("second");

      // Replacement: explicit name.
      const replaced = yield* stack.deploy(
        program({ description: "second", name: "ops-renamed" }),
      );
      expect(replaced.channel.notificationChannelName).toEqual("ops-renamed");
      expect(yield* waitGone(get(channel.notificationChannelName))).toEqual(
        "gone",
      );

      yield* stack.destroy();
      expect(yield* waitGone(get("ops-renamed"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
