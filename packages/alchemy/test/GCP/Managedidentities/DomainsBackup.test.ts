import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as managedidentities from "@distilled.cloud/gcp/managedidentities_v1";
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

// Backups require a provisioned Managed AD domain (20-60 minutes).
// Create against a missing parent returns `NotFound` (`parent resource
// not found for .../domains/missing.alch.test/backups/...`). Set
// GCP_TEST_MANAGEDIDENTITIES=1 to run the full lifecycle.
const runLifecycle =
  hasGcpCreds &&
  !process.env.FAST &&
  process.env.GCP_TEST_MANAGEDIDENTITIES === "1";
const project = process.env.GOOGLE_PROJECT_ID ?? "";
const missingDomain = `projects/${project}/locations/global/domains/missing.alch.test`;

const waitUntilGone = (name: string) =>
  managedidentities.getProjectsLocationsGlobalDomainsBackups({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsGlobalDomainsBackups on a missing backup fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        managedidentities.getProjectsLocationsGlobalDomainsBackups({
          name: `${missingDomain}/backups/alchemy-backup-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      const page = yield* managedidentities
        .listProjectsLocationsGlobalDomainsBackups({
          parent: missingDomain,
          pageSize: 10,
        })
        .pipe(
          Effect.catchTag(["NotFound", "Forbidden"], () =>
            Effect.succeed({ backups: [] as const }),
          ),
        );
      expect(Array.isArray(page.backups ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || runLifecycle)(
  "create is rejected with a typed tag when the parent domain is missing",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        stack.deploy(
          Effect.gen(function* () {
            return yield* GCP.Managedidentities.DomainsBackup("Nightly", {
              domain: missingDomain,
              labels: { env: "test" },
            });
          }),
        ),
      );
      expect(["Forbidden", "BadRequest", "NotFound"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a domain backup",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const domain = yield* GCP.Managedidentities.Domain("Ad", {
            reservedIpRange: "172.16.1.0/24",
            locations: ["us-central1"],
            authorizedNetworks: ["default"],
            labels: { env: "test" },
          });
          const backup = yield* GCP.Managedidentities.DomainsBackup("Nightly", {
            domain: domain.name,
            labels: { env: "test" },
          });
          return { domain, backup };
        }),
      );

      expect(created.backup.name).toContain("/backups/");
      expect(created.backup.backupId).toEqual(expect.any(String));
      expect(created.backup.domain).toEqual(created.domain.name);
      expect(created.backup.labels).toMatchObject({ env: "test" });

      const fetched =
        yield* managedidentities.getProjectsLocationsGlobalDomainsBackups({
          name: created.backup.name,
        });
      expect(fetched.name).toEqual(created.backup.name);
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const domain = yield* GCP.Managedidentities.Domain("Ad", {
            domainName: created.domain.domainName,
            reservedIpRange: "172.16.1.0/24",
            locations: ["us-central1"],
            authorizedNetworks: ["default"],
            labels: { env: "test" },
          });
          const backup = yield* GCP.Managedidentities.DomainsBackup("Nightly", {
            domain: domain.name,
            backupId: created.backup.backupId,
            labels: { env: "prod", role: "backup" },
          });
          return { domain, backup };
        }),
      );

      expect(updated.backup.name).toEqual(created.backup.name);
      expect(updated.backup.labels).toMatchObject({
        env: "prod",
        role: "backup",
      });

      const refetched =
        yield* managedidentities.getProjectsLocationsGlobalDomainsBackups({
          name: created.backup.name,
        });
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("backup");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.backup.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 240_000 },
);
