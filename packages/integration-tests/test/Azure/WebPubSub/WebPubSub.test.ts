import * as Azure from "@alchemy.run/azure";
import * as webpubsub from "@distilled.cloud/azure/webpubsub";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getWebPubSub = (resourceGroupName: string, resourceName: string) =>
  Effect.gen(function* () {
    return yield* webpubsub.GetWebPubSub({
      subscriptionId: yield* subscription,
      resourceGroupName,
      resourceName,
    });
  });

const program = (props: Partial<Azure.WebPubSub.WebPubSubProps>) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const service = yield* Azure.WebPubSub.WebPubSub("PubSub", {
      resourceGroup: group.resourceGroupName,
      ...props,
    });
    return { group, service };
  });

// Free_F1 is free; the replacement step runs a Standard_S1 unit
// (~$0.07/hour) for a few minutes. ~6-10 minutes overall.
test.provider(
  "create, update, replace, and delete a Web PubSub service",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, service } = yield* stack.deploy(program({ tags: { env: "test" } }));
      expect(service.sku).toEqual("Free_F1");
      expect(service.kind).toEqual("WebPubSub");
      expect(service.hostName).toEqual(`${service.webPubSubName}.webpubsub.azure.com`);
      expect(service.endpoint).toEqual(`https://${service.hostName}`);
      expect(Redacted.value(service.primaryConnectionString!)).toContain(
        `Endpoint=https://${service.hostName}`,
      );
      const observed = yield* getWebPubSub(group.resourceGroupName, service.webPubSubName);
      expect(observed.sku?.name).toEqual("Free_F1");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::stack"]).toEqual(stack.name);

      // In place: live trace, Entra ID only, and tags.
      const updated = yield* stack.deploy(
        program({
          liveTrace: {
            enabled: true,
            categories: [{ name: "ConnectivityLogs", enabled: true }],
          },
          disableLocalAuth: true,
          tags: { env: "prod" },
        }),
      );
      expect(updated.service.webPubSubId).toEqual(service.webPubSubId);
      expect(updated.service.primaryKey).toEqual(undefined);
      expect(updated.service.tags).toEqual({ env: "prod" });
      const reobserved = yield* getWebPubSub(group.resourceGroupName, service.webPubSubName);
      expect(reobserved.properties?.liveTraceConfiguration?.enabled?.toLowerCase()).toEqual(
        "true",
      );
      expect(
        reobserved.properties?.liveTraceConfiguration?.categories
          ?.find((c) => c.name === "ConnectivityLogs")
          ?.enabled?.toLowerCase(),
      ).toEqual("true");
      expect(reobserved.properties?.disableLocalAuth).toEqual(true);
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: the kind is immutable. A Standard unit avoids the
      // one-Free-service-per-region limit while both exist.
      const replaced = yield* stack.deploy(
        program({
          kind: "SocketIO",
          sku: "Standard_S1",
          socketIOServiceMode: "Serverless",
          tags: { env: "prod" },
        }),
      );
      expect(replaced.service.webPubSubName).not.toEqual(service.webPubSubName);
      const replacedObserved = yield* getWebPubSub(
        group.resourceGroupName,
        replaced.service.webPubSubName,
      );
      expect(replacedObserved.kind).toEqual("SocketIO");
      expect(replacedObserved.sku?.name).toEqual("Standard_S1");
      expect(replacedObserved.properties?.socketIO?.serviceMode).toEqual("Serverless");
      expect(
        yield* waitGone(getWebPubSub(group.resourceGroupName, service.webPubSubName)),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(getWebPubSub(group.resourceGroupName, replaced.service.webPubSubName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
