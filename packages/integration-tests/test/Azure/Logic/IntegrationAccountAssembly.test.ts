import * as Azure from "@alchemy.run/azure";
import * as logic from "@distilled.cloud/azure/logic";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { freeAccount, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

// Azure stores the bytes without loading them, so a placeholder payload is
// enough to exercise the lifecycle. "hello world" (11 bytes).
const CONTENT_A = "aGVsbG8gd29ybGQ=";
// "goodbye world!" (14 bytes).
const CONTENT_B = "Z29vZGJ5ZSB3b3JsZCE=";

const program = (props: { name?: string; content: string; version: string }) =>
  Effect.gen(function* () {
    // One Free account per region per subscription: this file owns westcentralus.
    const { group, account } = yield* freeAccount("westcentralus");
    const assembly = yield* Azure.Logic.IntegrationAccountAssembly("Helpers", {
      resourceGroup: group.resourceGroupName,
      integrationAccount: account.integrationAccountName,
      name: props.name,
      assemblyName: "Contoso.MapHelpers",
      assemblyVersion: props.version,
      assemblyCulture: "neutral",
      assemblyPublicKeyToken: "b77a5c561934e089",
      content: props.content,
    });
    return { group, account, assembly };
  });

const getAssembly = (rg: string, account: string, assemblyArtifactName: string) =>
  Effect.gen(function* () {
    return yield* logic.GetIntegrationAccountAssembly({
      subscriptionId: yield* subscription,
      resourceGroupName: rg,
      integrationAccountName: account,
      assemblyArtifactName,
    });
  });

// Free integration account: no cost, synchronous.
test.provider(
  "create, update, replace, and delete an integration account assembly",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account, assembly } = yield* stack.deploy(
        program({ content: CONTENT_A, version: "1.0.0.0" }),
      );
      const rg = group.resourceGroupName;
      const ia = account.integrationAccountName;
      expect(assembly.assemblyName).toEqual("Contoso.MapHelpers");
      expect(assembly.assemblyVersion).toEqual("1.0.0.0");
      expect(assembly.contentSize).toEqual(11);
      const observed = yield* getAssembly(rg, ia, assembly.assemblyArtifactName);
      expect(observed.properties.assemblyName).toEqual("Contoso.MapHelpers");
      expect(observed.properties.contentLink?.contentSize).toEqual(11);
      expect((observed.properties.metadata as Record<string, unknown>)["alchemy::id"]).toEqual(
        "Helpers",
      );

      // No-op: Azure echoes neither culture nor public key token; a redeploy must not rewrite.
      const unchanged = yield* stack.deploy(program({ content: CONTENT_A, version: "1.0.0.0" }));
      expect(unchanged.assembly.changedTime).toEqual(assembly.changedTime);

      // In-place: content (never echoed; detected via the metadata hash) and version.
      const updated = yield* stack.deploy(program({ content: CONTENT_B, version: "1.1.0.0" }));
      expect(updated.assembly.assemblyId).toEqual(assembly.assemblyId);
      const reobserved = yield* getAssembly(rg, ia, assembly.assemblyArtifactName);
      expect(reobserved.properties.assemblyVersion).toEqual("1.1.0.0");
      expect(reobserved.properties.contentLink?.contentSize).toEqual(14);

      // Replacement: a new artifact name.
      const replaced = yield* stack.deploy(
        program({ name: "helpers-v2", content: CONTENT_B, version: "1.1.0.0" }),
      );
      expect(replaced.assembly.assemblyArtifactName).toEqual("helpers-v2");
      expect(yield* waitGone(getAssembly(rg, ia, assembly.assemblyArtifactName))).toEqual("gone");
      const replacedObserved = yield* getAssembly(rg, ia, "helpers-v2");
      expect(replacedObserved.properties.assemblyVersion).toEqual("1.1.0.0");

      yield* stack.destroy();
      expect(yield* waitGone(getAssembly(rg, ia, "helpers-v2"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
