import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as signalr from "@distilled.cloud/azure/signalr";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getSignalR = (resourceGroupName: string, resourceName: string) =>
  Effect.gen(function* () {
    return yield* signalr.GetSignalR({
      subscriptionId: yield* subscription,
      resourceGroupName,
      resourceName,
    });
  });

const program = (props: Partial<Azure.SignalR.SignalRProps>) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const service = yield* Azure.SignalR.SignalR("Realtime", {
      resourceGroup: group.resourceGroupName,
      ...props,
    });
    return { group, service };
  });

// Free_F1 is free; the replacement step runs a Standard_S1 unit
// (~$0.07/hour) for a few minutes. ~6-10 minutes overall.
test.provider(
  "create, update, replace, and delete a SignalR service",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, service } = yield* stack.deploy(
        program({
          serviceMode: "Serverless",
          allowedOrigins: ["https://a.example.com"],
          tags: { env: "test" },
        }),
      );
      expect(service.sku).toEqual("Free_F1");
      expect(service.kind).toEqual("SignalR");
      expect(service.hostName).toEqual(
        `${service.signalRName}.service.signalr.net`,
      );
      expect(Redacted.value(service.primaryConnectionString!)).toContain(
        `Endpoint=https://${service.hostName}`,
      );
      const observed = yield* getSignalR(
        group.resourceGroupName,
        service.signalRName,
      );
      expect(
        observed.properties?.features?.find((f) => f.flag === "ServiceMode")
          ?.value,
      ).toEqual("Serverless");
      expect(observed.properties?.cors?.allowedOrigins).toEqual([
        "https://a.example.com",
      ]);
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toBeDefined();

      // In place: CORS, serverless timeout, and tags.
      const updated = yield* stack.deploy(
        program({
          serviceMode: "Serverless",
          allowedOrigins: ["https://a.example.com", "https://b.example.com"],
          connectionTimeoutInSeconds: 60,
          tags: { env: "prod" },
        }),
      );
      expect(updated.service.signalRId).toEqual(service.signalRId);
      const reobserved = yield* getSignalR(
        group.resourceGroupName,
        service.signalRName,
      );
      expect(
        [...(reobserved.properties?.cors?.allowedOrigins ?? [])].sort(),
      ).toEqual(["https://a.example.com", "https://b.example.com"]);
      expect(
        reobserved.properties?.serverless?.connectionTimeoutInSeconds,
      ).toEqual(60);
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: the kind is immutable. A Standard unit avoids the
      // one-Free-service-per-region limit while both exist.
      const replaced = yield* stack.deploy(
        program({
          kind: "RawWebSockets",
          sku: "Standard_S1",
          tags: { env: "prod" },
        }),
      );
      expect(replaced.service.signalRName).not.toEqual(service.signalRName);
      const replacedObserved = yield* getSignalR(
        group.resourceGroupName,
        replaced.service.signalRName,
      );
      expect(replacedObserved.kind).toEqual("RawWebSockets");
      expect(replacedObserved.sku?.name).toEqual("Standard_S1");
      expect(
        yield* waitGone(
          getSignalR(group.resourceGroupName, service.signalRName),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getSignalR(group.resourceGroupName, replaced.service.signalRName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
