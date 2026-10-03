import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as webpubsub from "@distilled.cloud/azure/webpubsub";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getHub = (
  resourceGroupName: string,
  resourceName: string,
  hubName: string,
) =>
  Effect.gen(function* () {
    return yield* webpubsub.GetWebPubSubHub({
      subscriptionId: yield* subscription,
      resourceGroupName,
      resourceName,
      hubName,
    });
  });

const program = (props: {
  name?: string;
  anonymousConnectPolicy: "allow" | "deny";
  keepAlive: number;
  eventPattern: string;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    // Free_F1: no charge.
    const service = yield* Azure.WebPubSub.WebPubSub("PubSub", {
      resourceGroup: group.resourceGroupName,
      sku: "Free_F1",
    });
    const hub = yield* Azure.WebPubSub.Hub("Hub", {
      resourceGroup: group.resourceGroupName,
      webPubSub: service.webPubSubName,
      name: props.name,
      anonymousConnectPolicy: props.anonymousConnectPolicy,
      webSocketKeepAliveIntervalInSeconds: props.keepAlive,
      eventHandlers: [
        {
          urlTemplate: "https://example.com/api/{hub}/{event}",
          userEventPattern: props.eventPattern,
          systemEvents: ["connected", "disconnected"],
        },
      ],
    });
    return { group, service, hub };
  });

test.provider(
  "create, update, replace, and delete a Web PubSub hub",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create with an engine-generated name.
      const { group, service, hub } = yield* stack.deploy(
        program({
          anonymousConnectPolicy: "deny",
          keepAlive: 20,
          eventPattern: "*",
        }),
      );
      const rg = group.resourceGroupName;
      const svc = service.webPubSubName;
      const observed = yield* getHub(rg, svc, hub.hubName);
      expect(observed.properties.anonymousConnectPolicy?.toLowerCase()).toEqual(
        "deny",
      );
      expect(observed.properties.webSocketKeepAliveIntervalInSeconds).toEqual(
        20,
      );
      expect(observed.properties.eventHandlers?.[0]?.urlTemplate).toEqual(
        "https://example.com/api/{hub}/{event}",
      );
      expect(observed.properties.eventHandlers?.[0]?.userEventPattern).toEqual(
        "*",
      );

      // In place: policy, keep-alive, and handler pattern change.
      const updated = yield* stack.deploy(
        program({
          anonymousConnectPolicy: "allow",
          keepAlive: 45,
          eventPattern: "message",
        }),
      );
      expect(updated.hub.hubId).toEqual(hub.hubId);
      expect(updated.hub.anonymousConnectPolicy.toLowerCase()).toEqual("allow");
      const reobserved = yield* getHub(rg, svc, hub.hubName);
      expect(
        reobserved.properties.anonymousConnectPolicy?.toLowerCase(),
      ).toEqual("allow");
      expect(reobserved.properties.webSocketKeepAliveIntervalInSeconds).toEqual(
        45,
      );
      expect(
        reobserved.properties.eventHandlers?.[0]?.userEventPattern,
      ).toEqual("message");

      // Replacement: an explicit name change.
      const replaced = yield* stack.deploy(
        program({
          name: "replacedhub",
          anonymousConnectPolicy: "allow",
          keepAlive: 45,
          eventPattern: "message",
        }),
      );
      expect(replaced.hub.hubName).toEqual("replacedhub");
      expect(replaced.hub.hubId).not.toEqual(hub.hubId);
      const fresh = yield* getHub(rg, svc, "replacedhub");
      expect(fresh.properties.webSocketKeepAliveIntervalInSeconds).toEqual(45);
      expect(yield* waitGone(getHub(rg, svc, hub.hubName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(getHub(rg, svc, "replacedhub"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
