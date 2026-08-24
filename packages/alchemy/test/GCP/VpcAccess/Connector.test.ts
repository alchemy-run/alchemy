import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as vpcaccess from "@distilled.cloud/gcp/vpcaccess_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

// Create + patch + delete each take ~2–4 minutes; skip unless explicitly enabled.
const runLifecycle =
  hasGcpCreds && !!process.env.GCP_TEST_VPC_ACCESS && !process.env.FAST;

const project = process.env.GOOGLE_PROJECT_ID ?? "";

const waitUntilGone = (name: string) =>
  vpcaccess.getProjectsLocationsConnectors({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsConnectors on a missing connector fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        vpcaccess.getProjectsLocationsConnectors({
          name: `projects/${project}/locations/us-central1/connectors/alchemy-vpc-con-missing`,
        }),
      );
      expect(error._tag).toBe("NotFound");

      const page = yield* vpcaccess.listProjectsLocationsConnectors({
        parent: `projects/${project}/locations/us-central1`,
        pageSize: 100,
      });
      expect(Array.isArray(page.connectors ?? [])).toEqual(true);

      const locations = yield* vpcaccess.listProjectsLocations({
        name: `projects/${project}`,
        pageSize: 100,
      });
      expect(Array.isArray(locations.locations ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a vpc access connector",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.VpcAccess.Connector("Egress", {
            location: "us-central1",
            network: "default",
            ipCidrRange: "10.88.0.0/28",
            machineType: "e2-micro",
            minInstances: 2,
            maxInstances: 3,
          });
        }),
      );

      expect(created.connectorId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1");
      expect(created.project).toEqual(project);
      expect(created.name).toEqual(
        `projects/${project}/locations/us-central1/connectors/${created.connectorId}`,
      );
      expect(created.state).toEqual("READY");
      expect(created.network).toEqual("default");
      expect(created.ipCidrRange).toEqual("10.88.0.0/28");
      expect(created.minInstances).toEqual(2);
      expect(created.maxInstances).toEqual(3);

      const fetched = yield* vpcaccess.getProjectsLocationsConnectors({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.state).toEqual("READY");
      expect(fetched.network).toEqual("default");
      expect(fetched.ipCidrRange).toEqual("10.88.0.0/28");
      expect(fetched.minInstances).toEqual(2);
      expect(fetched.maxInstances).toEqual(3);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.VpcAccess.Connector("Egress", {
            connectorId: created.connectorId,
            location: "us-central1",
            network: "default",
            ipCidrRange: "10.88.0.0/28",
            machineType: "e2-micro",
            minInstances: 2,
            maxInstances: 4,
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.maxInstances).toEqual(4);
      expect(updated.minInstances).toEqual(2);
      expect(updated.state).toEqual("READY");

      const fetchedUpdate = yield* vpcaccess.getProjectsLocationsConnectors({
        name: created.name,
      });
      expect(fetchedUpdate.maxInstances).toEqual(4);
      expect(fetchedUpdate.minInstances).toEqual(2);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 540_000 },
);
