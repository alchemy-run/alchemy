import * as Azure from "@alchemy.run/azure";
import * as logic from "@distilled.cloud/azure/logic";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { freeAccount, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const liquid = (greeting: string) => `{ "greeting": "${greeting} {{ content.name }}" }`;

const xslt = `<?xml version="1.0" encoding="utf-8"?>
<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">
  <xsl:template match="/"><Invoice><xsl:value-of select="/Order"/></Invoice></xsl:template>
</xsl:stylesheet>`;

const program = (props: { mapType: "Liquid" | "Xslt"; content: string; owner: string }) =>
  Effect.gen(function* () {
    // One Free account per region per subscription: this file owns northcentralus.
    const { group, account } = yield* freeAccount("northcentralus");
    const map = yield* Azure.Logic.IntegrationAccountMap("Greeting", {
      resourceGroup: group.resourceGroupName,
      integrationAccount: account.integrationAccountName,
      mapType: props.mapType,
      content: props.content,
      metadata: { owner: props.owner },
    });
    return { group, account, map };
  });

const getMap = (rg: string, account: string, mapName: string) =>
  Effect.gen(function* () {
    return yield* logic.GetIntegrationAccountMap({
      subscriptionId: yield* subscription,
      resourceGroupName: rg,
      integrationAccountName: account,
      mapName,
    });
  });

// Free integration account: no cost, synchronous.
test.provider(
  "create, update, replace, and delete an integration account map",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = liquid("Hello");
      const { group, account, map } = yield* stack.deploy(
        program({ mapType: "Liquid", content: first, owner: "a" }),
      );
      const rg = group.resourceGroupName;
      const ia = account.integrationAccountName;
      expect(map.mapType).toEqual("Liquid");
      expect(map.contentSize).toEqual(first.length);
      expect(map.metadata).toEqual({ owner: "a" });
      const observed = yield* getMap(rg, ia, map.mapName);
      expect(observed.properties.mapType).toEqual("Liquid");
      expect(observed.properties.contentLink?.contentSize).toEqual(first.length);
      const metadata = observed.properties.metadata as Record<string, unknown>;
      expect(metadata.owner).toEqual("a");
      expect(metadata["alchemy::id"]).toEqual("Greeting");

      // In-place: content (never echoed; detected via the metadata hash).
      const second = liquid("Good morning");
      const updated = yield* stack.deploy(
        program({ mapType: "Liquid", content: second, owner: "b" }),
      );
      expect(updated.map.mapId).toEqual(map.mapId);
      const reobserved = yield* getMap(rg, ia, map.mapName);
      expect(reobserved.properties.contentLink?.contentSize).toEqual(second.length);
      expect((reobserved.properties.metadata as Record<string, unknown>).owner).toEqual("b");

      // Replacement: a new map type.
      const replaced = yield* stack.deploy(program({ mapType: "Xslt", content: xslt, owner: "b" }));
      expect(replaced.map.mapType).toEqual("Xslt");
      expect(replaced.map.mapName).not.toEqual(map.mapName);
      expect(yield* waitGone(getMap(rg, ia, map.mapName))).toEqual("gone");
      const replacedObserved = yield* getMap(rg, ia, replaced.map.mapName);
      expect(replacedObserved.properties.mapType).toEqual("Xslt");

      yield* stack.destroy();
      expect(yield* waitGone(getMap(rg, ia, replaced.map.mapName))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
