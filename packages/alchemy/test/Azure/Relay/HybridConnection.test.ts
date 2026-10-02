import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as relay from "@distilled.cloud/azure/relay";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { gone, logLevel, subscriptionId, tags } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getConnection = (
  resourceGroupName: string,
  namespaceName: string,
  hybridConnectionName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    relay.GetHybridConnection({
      subscriptionId,
      resourceGroupName,
      namespaceName,
      hybridConnectionName,
    }),
  );

const program = (props: {
  requiresClientAuthorization: boolean;
  userMetadata: string;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const ns = yield* Azure.Relay.Namespace("Relay", {
      resourceGroup: group.resourceGroupName,
    });
    const hc = yield* Azure.Relay.HybridConnection("Connection", {
      resourceGroup: group.resourceGroupName,
      namespace: ns.namespaceName,
      requiresClientAuthorization: props.requiresClientAuthorization,
      userMetadata: props.userMetadata,
    });
    return { group, ns, hc };
  });

// Relay namespace + hybrid connection with no listeners: ~$0; a few minutes.
test.provider(
  "create, update, replace, and delete a relay hybrid connection",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, ns, hc } = yield* stack.deploy(
        program({ requiresClientAuthorization: true, userMetadata: "v1" }),
      );
      const rg = group.resourceGroupName;
      expect(hc.hybridConnectionName).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
      expect(hc.requiresClientAuthorization).toEqual(true);
      expect(hc.userMetadata).toEqual("v1");
      expect(hc.endpoint).toEqual(
        `sb://${ns.namespaceName}.servicebus.windows.net/${hc.hybridConnectionName}`,
      );
      const observed = yield* getConnection(
        rg,
        ns.namespaceName,
        hc.hybridConnectionName,
      );
      expect(observed.properties?.requiresClientAuthorization).toEqual(true);
      expect(observed.properties?.userMetadata).toMatch(
        /^v1 \[alchemy .+\/Connection\]$/,
      );

      // In place: user metadata.
      const updated = yield* stack.deploy(
        program({ requiresClientAuthorization: true, userMetadata: "v2" }),
      );
      expect(updated.hc.hybridConnectionName).toEqual(hc.hybridConnectionName);
      const reobserved = yield* getConnection(
        rg,
        ns.namespaceName,
        hc.hybridConnectionName,
      );
      expect(reobserved.properties?.userMetadata).toMatch(/^v2 \[alchemy /);

      // Replacement: client authorization is immutable.
      const replaced = yield* stack.deploy(
        program({ requiresClientAuthorization: false, userMetadata: "v2" }),
      );
      expect(replaced.hc.hybridConnectionName).not.toEqual(
        hc.hybridConnectionName,
      );
      const anonymous = yield* getConnection(
        rg,
        ns.namespaceName,
        replaced.hc.hybridConnectionName,
      );
      expect(anonymous.properties?.requiresClientAuthorization).toEqual(false);
      expect(
        yield* gone(getConnection(rg, ns.namespaceName, hc.hybridConnectionName)),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* gone(
          getConnection(rg, ns.namespaceName, replaced.hc.hybridConnectionName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
