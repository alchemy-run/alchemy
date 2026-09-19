import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as vmwareengine from "@distilled.cloud/gcp/vmwareengine_v1";
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

const runLifecycle =
  hasGcpCreds && !!process.env.GCP_TEST_VMWAREENGINE && !process.env.FAST;

const project = process.env.GOOGLE_PROJECT_ID ?? "";

const waitUntilGone = (name: string) =>
  vmwareengine.getProjectsLocationsDatastores({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.catchTag("Forbidden", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsDatastores on a missing datastore fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        vmwareengine.getProjectsLocationsDatastores({
          name: `projects/${project}/locations/us-central1/datastores/alchemy-ds-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      const page = yield* vmwareengine
        .listProjectsLocationsDatastores({
          parent: `projects/${project}/locations/us-central1`,
          pageSize: 10,
        })
        .pipe(
          Effect.catchTag("Forbidden", () =>
            Effect.succeed({ datastores: [] as const }),
          ),
        );
      expect(Array.isArray(page.datastores ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_VMWAREENGINE)(
  "createProjectsLocationsDatastores without entitlement fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        vmwareengine.createProjectsLocationsDatastores({
          parent: `projects/${project}/locations/us-central1`,
          datastoreId: "alchemy-ds-probe",
          body: {
            nfsDatastore: {
              thirdPartyFileService: {
                servers: ["10.0.0.8"],
                network: `projects/${project}/global/networks/default`,
                fileShare: "vol1",
              },
            },
            description: "alchemy probe",
          },
        }),
      );
      expect(["Forbidden", "NotFound", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a datastore",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Vmwareengine.Datastore("Nfs", {
            nfsDatastore: {
              thirdPartyFileService: {
                servers: ["10.0.0.8"],
                network: `projects/${project}/global/networks/default`,
                fileShare: "vol1",
              },
            },
            description: "alchemy-test-ds",
          });
        }),
      );

      expect(created.name).toContain("/datastores/");
      expect(created.datastoreId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1");
      expect(created.description).toEqual("alchemy-test-ds");

      const fetched = yield* vmwareengine.getProjectsLocationsDatastores({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("alchemy-test-ds");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Vmwareengine.Datastore("Nfs", {
            datastoreId: created.datastoreId,
            nfsDatastore: created.nfsDatastore ?? {
              thirdPartyFileService: {
                servers: ["10.0.0.8"],
                network: `projects/${project}/global/networks/default`,
                fileShare: "vol1",
              },
            },
            description: "alchemy-prod-ds",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("alchemy-prod-ds");

      const refetched = yield* vmwareengine.getProjectsLocationsDatastores({
        name: created.name,
      });
      expect(refetched.description).toContain("alchemy-prod-ds");
      expect(refetched.description).toContain("alchemy-id=");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
