import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as relay from "@distilled.cloud/azure/relay";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { gone, logLevel, subscriptionId, tags } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getRelay = (
  resourceGroupName: string,
  namespaceName: string,
  relayName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    relay.GetWCFRelay({
      subscriptionId,
      resourceGroupName,
      namespaceName,
      relayName,
    }),
  );

const program = (props: {
  relayType: "NetTcp" | "Http";
  userMetadata: string;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const ns = yield* Azure.Relay.Namespace("Relay", {
      resourceGroup: group.resourceGroupName,
    });
    const wcf = yield* Azure.Relay.WcfRelay("Wcf", {
      resourceGroup: group.resourceGroupName,
      namespace: ns.namespaceName,
      relayType: props.relayType,
      userMetadata: props.userMetadata,
    });
    return { group, ns, wcf };
  });

// Relay namespace + WCF relay with no listeners: ~$0; a few minutes.
test.provider(
  "create, update, replace, and delete a relay wcf relay",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, ns, wcf } = yield* stack.deploy(
        program({ relayType: "NetTcp", userMetadata: "v1" }),
      );
      const rg = group.resourceGroupName;
      expect(wcf.relayType).toEqual("NetTcp");
      expect(wcf.requiresClientAuthorization).toEqual(true);
      expect(wcf.requiresTransportSecurity).toEqual(true);
      expect(wcf.userMetadata).toEqual("v1");
      const observed = yield* getRelay(rg, ns.namespaceName, wcf.relayName);
      expect(observed.properties?.relayType).toEqual("NetTcp");
      expect(observed.properties?.userMetadata).toMatch(
        /^v1 \[alchemy .+\/Wcf\]$/,
      );

      // In place: user metadata.
      const updated = yield* stack.deploy(
        program({ relayType: "NetTcp", userMetadata: "v2" }),
      );
      expect(updated.wcf.relayName).toEqual(wcf.relayName);
      const reobserved = yield* getRelay(rg, ns.namespaceName, wcf.relayName);
      expect(reobserved.properties?.userMetadata).toMatch(/^v2 \[alchemy /);

      // Replacement: relay type is immutable.
      const replaced = yield* stack.deploy(
        program({ relayType: "Http", userMetadata: "v2" }),
      );
      expect(replaced.wcf.relayName).not.toEqual(wcf.relayName);
      const http = yield* getRelay(
        rg,
        ns.namespaceName,
        replaced.wcf.relayName,
      );
      expect(http.properties?.relayType).toEqual("Http");
      expect(
        yield* gone(getRelay(rg, ns.namespaceName, wcf.relayName)),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* gone(getRelay(rg, ns.namespaceName, replaced.wcf.relayName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
