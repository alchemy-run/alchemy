import * as GCP from "@alchemy.run/gcp";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: GCP.providers() });

const tags = ["provider:gcp", "provider:gcp:datamigration", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError.
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-connection-profile": GCP.DataMigration.ConnectionProfile.lookup({
          connectionProfileId: name,
        }).name,
        "missing-conversion-workspace": GCP.DataMigration.ConversionWorkspace.lookup({
          conversionWorkspaceId: name,
        }).name,
        "missing-conversion-workspaces-mapping-rule":
          GCP.DataMigration.ConversionWorkspacesMappingRule.lookup({
            mappingRuleId: name,
            conversionWorkspace: name,
          }).name,
        "missing-migration-job": GCP.DataMigration.MigrationJob.lookup({ migrationJobId: name })
          .name,
        "missing-private-connection": GCP.DataMigration.PrivateConnection.lookup({
          privateConnectionId: name,
        }).name,
      });
    }),
  { tags, timeout: 135000 },
);
