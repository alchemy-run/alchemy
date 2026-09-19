import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as dataplex from "@distilled.cloud/gcp/dataplex_v1";
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
  hasGcpCreds &&
  !process.env.FAST &&
  process.env.GCP_TEST_DATAPLEX_DATA_DOMAIN === "1";
const project = process.env.GOOGLE_PROJECT_ID ?? "";

const waitUntilGone = (name: string) =>
  dataplex.getProjectsLocationsDataDomainsBindings({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsDataDomainsBindings on a missing binding fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dataplex.getProjectsLocationsDataDomainsBindings({
          name: `projects/${project}/locations/us-central1/dataDomains/alchemy-missing/bindings/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create and delete a data domain binding",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const domain = yield* GCP.Dataplex.DataDomain("Finance", {
            location: "us-central1",
            displayName: "Finance",
            labels: { env: "test" },
            contacts: {
              identities: [
                {
                  contactName: "steward",
                  contactRole: "steward",
                  contactId: "steward@example.com",
                },
              ],
            },
          });
          return yield* GCP.Dataplex.DataDomainsBinding("Project", {
            parent: domain.name,
            resource: `//cloudresourcemanager.googleapis.com/projects/${project}`,
          });
        }),
      );

      expect(created.name).toContain("/bindings/");
      expect(created.dataDomainBindingId).toEqual(expect.any(String));
      expect(created.resource).toContain(`projects/${project}`);

      const fetched = yield* dataplex.getProjectsLocationsDataDomainsBindings({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.resource).toEqual(created.resource);

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
