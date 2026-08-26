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
  runSlowLifecycle,
  waitUntilGone,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsPrivateConnections on a missing connection fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        datamigration.getProjectsLocationsPrivateConnections({
          name: `projects/${project}/locations/us-central1/privateConnections/alchemy-missing-pconn`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runEntitlementProbe)(
  "createProjectsLocationsPrivateConnections without entitlement fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        datamigration.createProjectsLocationsPrivateConnections({
          parent: `projects/${project}/locations/us-central1`,
          privateConnectionId: "alchemy-pconn-probe",
          skipValidation: true,
          body: {
            displayName: "probe",
            vpcPeeringConfig: {
              vpcName: `projects/${project}/global/networks/default`,
              subnet: "10.8.0.0/29",
            },
          },
        }),
      );
      expect(["Forbidden", "NotFound", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runSlowLifecycle)(
  "create and delete a private connection",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const network = yield* GCP.Compute.Network("DmsVpc", {
            autoCreateSubnetworks: false,
          });
          const peering = yield* GCP.Datamigration.PrivateConnection(
            "DmsPeer",
            {
              location: "us-central1",
              displayName: "dms-peer",
              labels: { env: "test" },
              skipValidation: true,
              vpcPeeringConfig: {
                vpcName: network.networkName,
                subnet: "10.8.0.0/29",
              },
            },
          );
          return { network, peering };
        }),
      );

      expect(created.peering.privateConnectionId).toEqual(expect.any(String));
      expect(created.peering.name).toEqual(
        `projects/${project}/locations/us-central1/privateConnections/${created.peering.privateConnectionId}`,
      );
      expect(created.peering.location).toEqual("us-central1");
      expect(created.peering.displayName).toEqual("dms-peer");
      expect(created.peering.labels).toMatchObject({ env: "test" });
      expect(created.peering.vpcPeeringConfig?.subnet).toEqual("10.8.0.0/29");

      const fetched =
        yield* datamigration.getProjectsLocationsPrivateConnections({
          name: created.peering.name,
        });
      expect(fetched.name).toEqual(created.peering.name);
      expect(fetched.displayName).toEqual("dms-peer");
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.vpcPeeringConfig?.subnet).toEqual("10.8.0.0/29");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        datamigration.getProjectsLocationsPrivateConnections({
          name: created.peering.name,
        }),
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
