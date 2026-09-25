import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as baremetalsolution from "@distilled.cloud/gcp/baremetalsolution_v2";
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

// Bare Metal Solution API is disabled on the default testing project
// (`Forbidden`: "Bare Metal Solution API has not been used in project
// alchemy-gcp-testing-83661 before or it is disabled."). Creating an NFS
// share also needs physical BMS hardware and a client network. Set
// GCP_TEST_BAREMETALSOLUTION=1 on an entitled project to run the full
// lifecycle.
const runLifecycle =
  hasGcpCreds &&
  !process.env.FAST &&
  process.env.GCP_TEST_BAREMETALSOLUTION === "1";

const project = process.env.GOOGLE_PROJECT_ID ?? "";

const missingNetwork = (projectId: string) =>
  `projects/${projectId}/locations/us-central1/networks/alchemy-missing-bms-net`;

const dummyClients = [
  {
    network: missingNetwork(project),
    allowedClientsCidr: "10.200.0.0/28",
    mountPermissions: "READ_WRITE" as const,
    noRootSquash: true,
  },
];

const waitUntilGone = (name: string) =>
  baremetalsolution.getProjectsLocationsNfsShares({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsNfsShares on a missing share fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        baremetalsolution.getProjectsLocationsNfsShares({
          name: `projects/${project}/locations/us-central1/nfsShares/alchemy-bms-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      const page = yield* baremetalsolution
        .listProjectsLocationsNfsShares({
          parent: `projects/${project}/locations/-`,
          pageSize: 10,
        })
        .pipe(
          Effect.catchTag(["NotFound", "Forbidden"], () =>
            Effect.succeed({ nfsShares: [] as const }),
          ),
        );
      expect(Array.isArray(page.nfsShares ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || runLifecycle)(
  "create is rejected with Forbidden when the Bare Metal Solution API is disabled",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        stack.deploy(
          Effect.gen(function* () {
            return yield* GCP.Baremetalsolution.NfsShare("Share", {
              requestedSizeGib: 100,
              storageType: "SSD",
              allowedClients: dummyClients,
              labels: { env: "test" },
            });
          }),
        ),
      );
      expect(error._tag).toEqual("Forbidden");
      expect(error.message).toContain("has not been used in project");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an NFS share",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const network =
        process.env.GCP_TEST_BAREMETALSOLUTION_NETWORK ??
        missingNetwork(project);

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Baremetalsolution.NfsShare("Share", {
            requestedSizeGib: 100,
            storageType: "SSD",
            allowedClients: [
              {
                network,
                allowedClientsCidr: "10.200.0.0/28",
                mountPermissions: "READ_WRITE",
                noRootSquash: true,
              },
            ],
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/nfsShares/");
      expect(created.nfsShareId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* baremetalsolution.getProjectsLocationsNfsShares({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Baremetalsolution.NfsShare("Share", {
            nfsShareId: created.nfsShareId,
            location: created.location,
            requestedSizeGib: created.requestedSizeGib,
            storageType: created.storageType,
            allowedClients: [
              {
                network,
                allowedClientsCidr: "10.200.0.0/28",
                mountPermissions: "READ_ONLY",
                noRootSquash: true,
              },
            ],
            labels: { env: "prod", team: "storage" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.labels).toMatchObject({ env: "prod", team: "storage" });

      const refetched = yield* baremetalsolution.getProjectsLocationsNfsShares({
        name: created.name,
      });
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.team).toEqual("storage");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
