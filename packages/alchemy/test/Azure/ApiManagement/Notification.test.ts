import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as apim from "@distilled.cloud/azure/apimanagement";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { basicV2Service, logLevel, subscriptionId, tags } from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getNotification = (
  resourceGroupName: string,
  serviceName: string,
  notificationName: Azure.ApiManagement.NotificationName,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    apim.GetNotification({
      subscriptionId,
      resourceGroupName,
      serviceName,
      notificationName,
    }),
  );

const program = (notificationName?: Azure.ApiManagement.NotificationName) =>
  Effect.gen(function* () {
    const { group, service } = yield* basicV2Service;
    const notification = notificationName
      ? yield* Azure.ApiManagement.Notification("Bcc", {
          resourceGroup: group.resourceGroupName,
          serviceName: service.serviceName,
          notificationName,
        })
      : undefined;
    return { group, service, notification };
  });

// Notifications are not available on Consumption ("Method not allowed in
// Consumption pricing tier"). A BasicV2 service bills ~$0.21/h and takes
// 5-15+ minutes to create: est. ~$0.10 and ~25 minutes per run.
test.provider.skipIf(!runExpensive)(
  "ensure, switch, and release a notification",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(program("BCC"));
      const rg = first.group.resourceGroupName;
      const svc = first.service.serviceName;
      expect(first.notification?.notificationName).toEqual("BCC");
      expect(first.notification?.title).not.toEqual("");
      expect((yield* getNotification(rg, svc, "BCC")).name).toEqual("BCC");

      // Replacement: managing another notification.
      const replaced = yield* stack.deploy(
        program("NewApplicationNotificationMessage"),
      );
      expect(replaced.notification?.notificationName).toEqual(
        "NewApplicationNotificationMessage",
      );

      // Notifications cannot be deleted; removing the resource leaves the
      // notification in place.
      yield* stack.deploy(program());
      expect((yield* getNotification(rg, svc, "BCC")).name).toEqual("BCC");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
