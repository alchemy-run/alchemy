import * as Azure from "@alchemy.run/azure";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { getHealthModel, gone, logLevel, tags } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: { name: string; tags: Record<string, string>; identity: boolean }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const model = yield* Azure.CloudHealth.HealthModel("Model", {
      resourceGroup: group.resourceGroupName,
      name: props.name,
      location: "centralus",
      tags: props.tags,
      identity: props.identity ? { type: "SystemAssigned" } : undefined,
    });
    return { group, model };
  });

// An empty health model is free; a few minutes per run.
test.provider(
  "create, update, replace, and delete a health model",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, model } = yield* stack.deploy(
        program({ name: "alchemy-hm-a", tags: { env: "test" }, identity: false }),
      );
      const rg = group.resourceGroupName;
      expect(model.healthModelName).toEqual("alchemy-hm-a");
      expect(model.provisioningState).toEqual("Succeeded");
      expect(model.tags).toEqual({ env: "test" });
      expect(model.identityType ?? "None").toEqual("None");
      const observed = yield* getHealthModel(rg, model.healthModelName);
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Model");

      // In place: tags and a system-assigned identity.
      const updated = yield* stack.deploy(
        program({ name: "alchemy-hm-a", tags: { env: "prod" }, identity: true }),
      );
      expect(updated.model.healthModelId).toEqual(model.healthModelId);
      expect(updated.model.identityType).toEqual("SystemAssigned");
      expect(updated.model.principalId).toMatch(/^[0-9a-f-]{36}$/);
      const reobserved = yield* getHealthModel(rg, model.healthModelName);
      expect(reobserved.tags?.env).toEqual("prod");
      expect(reobserved.identity?.type).toEqual("SystemAssigned");

      // Replacement: the name is the identity.
      const replaced = yield* stack.deploy(
        program({ name: "alchemy-hm-b", tags: { env: "prod" }, identity: true }),
      );
      expect(replaced.model.healthModelName).toEqual("alchemy-hm-b");
      const fresh = yield* getHealthModel(rg, "alchemy-hm-b");
      expect(fresh.identity?.type).toEqual("SystemAssigned");
      const replacedOld = yield* gone(getHealthModel(rg, "alchemy-hm-a"));
      expect(replacedOld).toEqual("gone");

      yield* stack.destroy();
      const destroyed = yield* gone(getHealthModel(rg, "alchemy-hm-b"));
      expect(destroyed).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
