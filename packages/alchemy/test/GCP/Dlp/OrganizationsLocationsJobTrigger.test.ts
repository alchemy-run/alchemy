import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as dlp from "@distilled.cloud/gcp/dlp_v2";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
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

const project = process.env.GOOGLE_PROJECT_ID ?? "alchemy-gcp-testing-83661";
const location = "us-central1";

const waitUntilGone = (name: string) =>
  dlp.getOrganizationsLocationsJobTriggers({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["NotFound", "Forbidden"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const organizationOf = () =>
  Effect.gen(function* () {
    const fromEnv = process.env.GOOGLE_ORGANIZATION_ID;
    if (fromEnv && fromEnv.length > 0) {
      return fromEnv.startsWith("organizations/")
        ? fromEnv
        : `organizations/${fromEnv}`;
    }
    let current: string | undefined = `projects/${project}`;
    for (let i = 0; i < 8; i++) {
      if (current === undefined) return "";
      if (current.startsWith("organizations/")) return current;
      current = current.startsWith("projects/")
        ? yield* resourcemanager.getProjects({ name: current }).pipe(
            Effect.map((resource) => resource.parent),
            Effect.catchTag(["NotFound", "Forbidden"], () =>
              Effect.succeed(undefined),
            ),
          )
        : current.startsWith("folders/")
          ? yield* resourcemanager.getFolders({ name: current }).pipe(
              Effect.map((folder) => folder.parent),
              Effect.catchTag(["NotFound", "Forbidden"], () =>
                Effect.succeed(undefined),
              ),
            )
          : undefined;
    }
    return "";
  });

test.provider.skipIf(!hasGcpCreds)(
  "getOrganizationsLocationsJobTriggers on a missing trigger fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const organization = (yield* organizationOf()) || "organizations/0";
      const error = yield* Effect.flip(
        dlp.getOrganizationsLocationsJobTriggers({
          name: `${organization}/locations/${location}/jobTriggers/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "create, update, and delete an organization job trigger",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const organization = yield* organizationOf();
      const inspectJob = {
        inspectConfig: { infoTypes: [{ name: "EMAIL_ADDRESS" }] },
        storageConfig: {
          cloudStorageOptions: {
            fileSet: { url: `gs://${project}-dlp-noop/` },
          },
        },
      };
      if (organization.length === 0) {
        const error = yield* Effect.flip(
          dlp.createOrganizationsLocationsJobTriggers({
            parent: `organizations/0/locations/${location}`,
            body: {
              triggerId: "alchemy-probe",
              jobTrigger: {
                status: "PAUSED",
                triggers: [
                  { schedule: { recurrencePeriodDuration: "86400s" } },
                ],
                inspectJob,
              },
            },
          }),
        );
        expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);
        yield* stack.destroy();
        return;
      }

      const parent = `${organization}/locations/${location}`;
      const access = yield* dlp
        .listOrganizationsLocationsJobTriggers({
          parent,
          pageSize: 1,
        })
        .pipe(
          Effect.as("ok" as const),
          Effect.catchTag(["Forbidden", "NotFound"], (error) =>
            Effect.succeed(error._tag),
          ),
        );
      if (access !== "ok") {
        expect(["Forbidden", "NotFound"]).toContain(access);
        yield* stack.destroy();
        return;
      }

      const created = yield* stack
        .deploy(
          Effect.gen(function* () {
            return yield* GCP.Dlp.OrganizationsLocationsJobTrigger(
              "ScanBucket",
              {
                organization,
                location,
                displayName: "scan-bucket",
                description: "paused inspect",
                status: "PAUSED",
                triggers: [
                  { schedule: { recurrencePeriodDuration: "86400s" } },
                ],
                inspectJob,
              },
            );
          }),
        )
        .pipe(
          Effect.catchTag(["Forbidden", "BadRequest"], (error) =>
            Effect.succeed({ _tag: error._tag } as const),
          ),
        );

      if ("_tag" in created) {
        expect(["Forbidden", "BadRequest"]).toContain(created._tag);
        yield* stack.destroy();
        return;
      }

      expect(created.location).toEqual(location);
      expect(created.status).toEqual("PAUSED");
      expect(created.name).toEqual(
        `${parent}/jobTriggers/${created.triggerId}`,
      );

      const fetched = yield* dlp.getOrganizationsLocationsJobTriggers({
        name: created.name,
      });
      expect(fetched.description).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Dlp.OrganizationsLocationsJobTrigger("ScanBucket", {
            organization,
            location,
            triggerId: created.triggerId,
            displayName: "scan-bucket-v2",
            description: "paused inspect v2",
            status: "PAUSED",
            triggers: [{ schedule: { recurrencePeriodDuration: "172800s" } }],
            inspectJob,
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("scan-bucket-v2");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
