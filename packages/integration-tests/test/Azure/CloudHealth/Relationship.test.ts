import * as Azure from "@alchemy.run/azure";
import * as cloudhealth from "@distilled.cloud/azure/cloudhealth";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { gone, logLevel, modelProgram, modelWhere, tags } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getRelationship = (rg: string, model: string, relationshipName: string) =>
  Effect.flatMap(modelWhere(rg, model), (where) =>
    cloudhealth.GetRelationship({ ...where, relationshipName }),
  );

const program = (props: { child: "Api" | "Db"; displayName: string; env: string }) =>
  Effect.gen(function* () {
    const { group, model } = yield* modelProgram;
    const where = {
      resourceGroup: group.resourceGroupName,
      healthModel: model.healthModelName,
    };
    const shop = yield* Azure.CloudHealth.Entity("Shop", {
      ...where,
      signalGroups: { dependencies: { aggregationType: "WorstOf" } },
    });
    // Both children stay deployed across the replacement step.
    const api = yield* Azure.CloudHealth.Entity("Api", where);
    const db = yield* Azure.CloudHealth.Entity("Db", where);
    const relationship = yield* Azure.CloudHealth.Relationship("Edge", {
      ...where,
      parentEntity: shop.entityName,
      childEntity: props.child === "Api" ? api.entityName : db.entityName,
      displayName: props.displayName,
      tags: { env: props.env },
    });
    return { group, model, shop, api, db, relationship };
  });

// An empty health model is free; a few minutes per run.
test.provider(
  "create, update, replace, and delete a health model relationship",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, model, shop, api, relationship } = yield* stack.deploy(
        program({ child: "Api", displayName: "v1", env: "test" }),
      );
      const rg = group.resourceGroupName;
      const hm = model.healthModelName;
      expect(relationship.parentEntityName).toEqual(shop.entityName);
      expect(relationship.childEntityName).toEqual(api.entityName);
      expect(relationship.tags).toEqual({ env: "test" });
      const observed = yield* getRelationship(rg, hm, relationship.relationshipName);
      expect(observed.properties?.displayName).toEqual("v1");
      expect(observed.properties?.tags?.["alchemy::id"]).toEqual("Edge");

      // In place: display name and tags.
      const updated = yield* stack.deploy(
        program({ child: "Api", displayName: "v2", env: "prod" }),
      );
      expect(updated.relationship.relationshipId).toEqual(relationship.relationshipId);
      const reobserved = yield* getRelationship(rg, hm, relationship.relationshipName);
      expect(reobserved.properties?.displayName).toEqual("v2");
      expect(reobserved.properties?.tags?.env).toEqual("prod");

      // Replacement: the child entity is part of the identity.
      const replaced = yield* stack.deploy(
        program({ child: "Db", displayName: "v2", env: "prod" }),
      );
      expect(replaced.relationship.relationshipName).not.toEqual(relationship.relationshipName);
      const fresh = yield* getRelationship(rg, hm, replaced.relationship.relationshipName);
      expect(fresh.properties?.childEntityName).toEqual(replaced.db.entityName);
      const replacedOld = yield* gone(getRelationship(rg, hm, relationship.relationshipName));
      expect(replacedOld).toEqual("gone");

      yield* stack.destroy();
      const destroyed = yield* gone(getRelationship(rg, hm, replaced.relationship.relationshipName));
      expect(destroyed).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
