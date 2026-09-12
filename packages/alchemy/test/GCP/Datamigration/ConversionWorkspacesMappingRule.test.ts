import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as datamigration from "@distilled.cloud/gcp/datamigration_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  hasGcpCreds,
  logLevel,
  project,
  runEntitlementProbe,
  runLifecycle,
  waitUntilGone,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsConversionWorkspacesMappingRules on a missing rule fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        datamigration.getProjectsLocationsConversionWorkspacesMappingRules({
          name: `projects/${project}/locations/us-central1/conversionWorkspaces/alchemy-missing-workspace/mappingRules/alchemy-missing-rule`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runEntitlementProbe)(
  "createProjectsLocationsConversionWorkspacesMappingRules without entitlement fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        datamigration.createProjectsLocationsConversionWorkspacesMappingRules({
          parent: `projects/${project}/locations/us-central1/conversionWorkspaces/alchemy-missing-workspace`,
          mappingRuleId: "alchemy-rule-probe",
          body: {
            displayName: "probe",
            ruleScope: "DATABASE_ENTITY_TYPE_SCHEMA",
            ruleOrder: "1",
            filter: { entities: ["src_schema"] },
            singleEntityRename: { newName: "dst_schema" },
          },
        }),
      );
      expect(["Forbidden", "NotFound"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create and delete a conversion workspace mapping rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const workspace = yield* GCP.Datamigration.ConversionWorkspace(
            "MysqlToPg",
            {
              location: "us-central1",
              displayName: "rule-workspace",
              source: { engine: "MYSQL", version: "8.0" },
              destination: { engine: "POSTGRESQL", version: "14" },
            },
          );
          const rule = yield* GCP.Datamigration.ConversionWorkspacesMappingRule(
            "Rename",
            {
              conversionWorkspace: workspace.name,
              location: "us-central1",
              displayName: "rename-schema",
              ruleScope: "DATABASE_ENTITY_TYPE_SCHEMA",
              ruleOrder: "1000",
              filter: { entities: ["src_schema"] },
              singleEntityRename: { newName: "dst_schema" },
            },
          );
          return { workspace, rule };
        }),
      );

      expect(created.rule.mappingRuleId).toEqual(expect.any(String));
      expect(created.rule.name).toEqual(
        `${created.workspace.name}/mappingRules/${created.rule.mappingRuleId}`,
      );
      expect(created.rule.conversionWorkspace).toEqual(created.workspace.name);
      expect(created.rule.displayName).toEqual("rename-schema");
      expect(created.rule.ruleScope).toEqual("DATABASE_ENTITY_TYPE_SCHEMA");
      expect(created.rule.singleEntityRename?.newName).toEqual("dst_schema");

      const fetched =
        yield* datamigration.getProjectsLocationsConversionWorkspacesMappingRules(
          { name: created.rule.name },
        );
      expect(fetched.name).toEqual(created.rule.name);
      expect(fetched.displayName).toContain("alchemy-id=");
      expect(fetched.singleEntityRename?.newName).toEqual("dst_schema");
      expect(fetched.filter?.entities).toContain("src_schema");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        datamigration.getProjectsLocationsConversionWorkspacesMappingRules({
          name: created.rule.name,
        }),
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
