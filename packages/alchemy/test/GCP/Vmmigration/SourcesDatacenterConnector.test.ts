import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as vmmigration from "@distilled.cloud/gcp/vmmigration_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  dummyAws,
  hasGcpCreds,
  logLevel,
  project,
  runEntitlementProbe,
  runLifecycle,
  waitUntilGone,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsSourcesDatacenterConnectors on a missing connector fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        vmmigration.getProjectsLocationsSourcesDatacenterConnectors({
          name: `projects/${project}/locations/us-central1/sources/alchemy-missing-source/datacenterConnectors/alchemy-missing-connector`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runEntitlementProbe)(
  "createProjectsLocationsSourcesDatacenterConnectors without entitlement fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        vmmigration.createProjectsLocationsSourcesDatacenterConnectors({
          parent: `projects/${project}/locations/us-central1/sources/alchemy-missing-source`,
          datacenterConnectorId: "alchemy-connector-probe",
          body: {
            registrationId: "alchemy-connector-probe",
            version: "1.0.0",
          },
        }),
      );
      expect(["Forbidden", "NotFound", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create and delete a vm migration datacenter connector",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const source = yield* GCP.Vmmigration.Source("ConnectorSource", {
            aws: dummyAws,
          });
          return yield* GCP.Vmmigration.SourcesDatacenterConnector(
            "Appliance",
            {
              source: source.name,
              version: "1.0.0",
            },
          );
        }),
      );

      expect(created.datacenterConnectorId).toEqual(expect.any(String));
      expect(created.name).toContain("/datacenterConnectors/");
      expect(created.source).toContain("/sources/");
      expect(created.version).toEqual("1.0.0");

      const fetched =
        yield* vmmigration.getProjectsLocationsSourcesDatacenterConnectors({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.version).toContain("alchemy-id=");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        vmmigration.getProjectsLocationsSourcesDatacenterConnectors({
          name: created.name,
        }),
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
