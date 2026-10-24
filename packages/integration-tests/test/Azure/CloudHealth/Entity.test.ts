import * as Azure from "@alchemy.run/azure";
import * as cloudhealth from "@distilled.cloud/azure/cloudhealth";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { gone, logLevel, modelProgram, modelWhere, tags } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getEntity = (rg: string, model: string, entityName: string) =>
  Effect.flatMap(modelWhere(rg, model), (where) => cloudhealth.GetEntity({ ...where, entityName }));

const program = (props: {
  name: string;
  displayName: string;
  impact: Azure.CloudHealth.EntityImpact;
  healthObjective?: number;
  env: string;
}) =>
  Effect.gen(function* () {
    const { group, model } = yield* modelProgram;
    const entity = yield* Azure.CloudHealth.Entity("Entity", {
      resourceGroup: group.resourceGroupName,
      healthModel: model.healthModelName,
      name: props.name,
      displayName: props.displayName,
      impact: props.impact,
      healthObjective: props.healthObjective,
      canvasPosition: { x: 10, y: 20 },
      signalGroups: { dependencies: { aggregationType: "WorstOf" } },
      tags: { env: props.env },
    });
    return { group, model, entity };
  });

// An empty health model is free; a few minutes per run.
test.provider(
  "create, update, replace, and delete a health model entity",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, model, entity } = yield* stack.deploy(
        program({ name: "entity-a", displayName: "Shop", impact: "Standard", env: "test" }),
      );
      const rg = group.resourceGroupName;
      const hm = model.healthModelName;
      expect(entity.entityName).toEqual("entity-a");
      expect(entity.displayName).toEqual("Shop");
      expect(entity.tags).toEqual({ env: "test" });
      const observed = yield* getEntity(rg, hm, "entity-a");
      expect(observed.properties?.impact).toEqual("Standard");
      expect(observed.properties?.canvasPosition).toEqual({ x: 10, y: 20 });
      expect(observed.properties?.signalGroups?.dependencies?.aggregationType).toEqual("WorstOf");
      expect(observed.properties?.tags?.["alchemy::id"]).toEqual("Entity");

      // In place: display name, impact, health objective, and tags; the
      // signal groups and canvas position stay as they were.
      const updated = yield* stack.deploy(
        program({
          name: "entity-a",
          displayName: "Shop v2",
          impact: "Limited",
          healthObjective: 99,
          env: "prod",
        }),
      );
      expect(updated.entity.entityId).toEqual(entity.entityId);
      const reobserved = yield* getEntity(rg, hm, "entity-a");
      expect(reobserved.properties?.displayName).toEqual("Shop v2");
      expect(reobserved.properties?.impact).toEqual("Limited");
      expect(reobserved.properties?.healthObjective).toEqual(99);
      expect(reobserved.properties?.tags?.env).toEqual("prod");
      expect(reobserved.properties?.canvasPosition).toEqual({ x: 10, y: 20 });
      expect(reobserved.properties?.signalGroups?.dependencies?.aggregationType).toEqual("WorstOf");

      // Replacement: the name is the identity.
      const replaced = yield* stack.deploy(
        program({
          name: "entity-b",
          displayName: "Shop v2",
          impact: "Limited",
          healthObjective: 99,
          env: "prod",
        }),
      );
      expect(replaced.entity.entityName).toEqual("entity-b");
      const fresh = yield* getEntity(rg, hm, "entity-b");
      expect(fresh.properties?.displayName).toEqual("Shop v2");
      const replacedOld = yield* gone(getEntity(rg, hm, "entity-a"));
      expect(replacedOld).toEqual("gone");

      yield* stack.destroy();
      const destroyed = yield* gone(getEntity(rg, hm, "entity-b"));
      expect(destroyed).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
