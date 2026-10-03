import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as apim from "@distilled.cloud/azure/apimanagement";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { runExpensive } from "../gates.ts";
import { basicV2Service, logLevel, subscriptionId, tags } from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

const recipients = (resourceGroupName: string, serviceName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    apim.ListNotificationRecipientUserByNotification({
      subscriptionId,
      resourceGroupName,
      serviceName,
      notificationName: "BCC",
    }),
  ).pipe(
    Effect.map((page) =>
      (page.value ?? []).map(
        (r) => r.properties?.userId?.split("/").pop() ?? "",
      ),
    ),
  );

/** Poll until the BCC recipient users match `expected` (bounded). */
const untilRecipients = (
  resourceGroupName: string,
  serviceName: string,
  expected: string[],
) =>
  recipients(resourceGroupName, serviceName).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (users) => users.sort().join(",") === expected.sort().join(","),
      times: 10,
    }),
  );

const program = (user?: "jane" | "joe") =>
  Effect.gen(function* () {
    const { group, service } = yield* basicV2Service;
    // Both users stay deployed across the replacement step.
    const jane = yield* Azure.ApiManagement.User("Jane", {
      resourceGroup: group.resourceGroupName,
      serviceName: service.serviceName,
      name: "alchemy-jane",
      email: "alchemy-jane@example.com",
      firstName: "Jane",
      lastName: "Doe",
    });
    const joe = yield* Azure.ApiManagement.User("Joe", {
      resourceGroup: group.resourceGroupName,
      serviceName: service.serviceName,
      name: "alchemy-joe",
      email: "alchemy-joe@example.com",
      firstName: "Joe",
      lastName: "Doe",
    });
    const recipient = user
      ? yield* Azure.ApiManagement.NotificationRecipientUser("Ops", {
          resourceGroup: group.resourceGroupName,
          serviceName: service.serviceName,
          notificationName: "BCC",
          userName: user === "jane" ? jane.userName : joe.userName,
        })
      : undefined;
    return { group, service, recipient };
  });

// Notifications are not available on Consumption ("Method not allowed in
// Consumption pricing tier"). A BasicV2 service bills ~$0.21/h and takes
// 5-15+ minutes to create: est. ~$0.10 and ~25 minutes per run.
test.provider.skipIf(!runExpensive)(
  "subscribe, replace, and unsubscribe a notification user",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(program("jane"));
      const rg = first.group.resourceGroupName;
      const svc = first.service.serviceName;
      expect(first.recipient?.userName).toEqual("alchemy-jane");
      expect(yield* untilRecipients(rg, svc, ["alchemy-jane"])).toEqual([
        "alchemy-jane",
      ]);

      // Replacement: another user subscribes, the old one is removed.
      yield* stack.deploy(program("joe"));
      expect(yield* untilRecipients(rg, svc, ["alchemy-joe"])).toEqual([
        "alchemy-joe",
      ]);

      // Removing the resource unsubscribes the user.
      yield* stack.deploy(program());
      expect(yield* untilRecipients(rg, svc, [])).toEqual([]);

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
