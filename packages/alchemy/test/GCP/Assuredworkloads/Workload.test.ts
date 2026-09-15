import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as assuredworkloads from "@distilled.cloud/gcp/assuredworkloads_v1";
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
const defaultLocation = "us-central1";

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

const waitUntilGone = (name: string) =>
  assuredworkloads.getOrganizationsLocationsWorkloads({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["NotFound", "Forbidden"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const billingAccount = process.env.GOOGLE_BILLING_ACCOUNT
  ? process.env.GOOGLE_BILLING_ACCOUNT.startsWith("billingAccounts/")
    ? process.env.GOOGLE_BILLING_ACCOUNT
    : `billingAccounts/${process.env.GOOGLE_BILLING_ACCOUNT}`
  : undefined;

test.provider.skipIf(!hasGcpCreds)(
  "getOrganizationsLocationsWorkloads on a missing workload fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const organization = (yield* organizationOf()) || "organizations/0";
      const error = yield* Effect.flip(
        assuredworkloads.getOrganizationsLocationsWorkloads({
          name: `${organization}/locations/${defaultLocation}/workloads/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.FAST)(
  "create, update, and delete a workload",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const organization = yield* organizationOf();
      console.log(`assuredworkloads organization=${organization}`);
      if (organization.length === 0) {
        const error = yield* Effect.flip(
          assuredworkloads.createOrganizationsLocationsWorkloads({
            parent: `organizations/0/locations/${defaultLocation}`,
            body: {
              displayName: "alchemy probe",
              complianceRegime: "US_REGIONAL_ACCESS",
            },
          }),
        );
        console.log(
          `assuredworkloads create skip tag=${error._tag} message=${error.message}`,
        );
        expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);
        yield* stack.destroy();
        return;
      }

      const access = yield* assuredworkloads
        .listOrganizationsLocationsWorkloads({
          parent: `${organization}/locations/${defaultLocation}`,
          pageSize: 1,
        })
        .pipe(
          Effect.as("ok" as const),
          Effect.catchTag(["Forbidden", "NotFound"], (error) => {
            console.log(
              `assuredworkloads list skip tag=${error._tag} message=${error.message}`,
            );
            return Effect.succeed(error._tag);
          }),
        );
      if (access !== "ok") {
        expect(["Forbidden", "NotFound"]).toContain(access);
        yield* stack.destroy();
        return;
      }

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Assuredworkloads.Workload("Regulated", {
            organization,
            location: defaultLocation,
            displayName: "alchemy test",
            complianceRegime: "US_REGIONAL_ACCESS",
            billingAccount,
            labels: { env: "test" },
          });
        }),
      );

      expect(created.workloadId).toEqual(expect.any(String));
      expect(created.organization).toEqual(organization);
      expect(created.location).toEqual(defaultLocation);
      expect(created.name).toEqual(
        `${organization}/locations/${defaultLocation}/workloads/${created.workloadId}`,
      );
      expect(created.displayName).toEqual("alchemy test");
      expect(created.complianceRegime).toEqual("US_REGIONAL_ACCESS");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched =
        yield* assuredworkloads.getOrganizationsLocationsWorkloads({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Assuredworkloads.Workload("Regulated", {
            organization,
            location: defaultLocation,
            displayName: "alchemy prod",
            complianceRegime: "US_REGIONAL_ACCESS",
            billingAccount,
            labels: { env: "prod", role: "aw" },
            violationNotificationsEnabled: false,
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.workloadId).toEqual(created.workloadId);
      expect(updated.displayName).toEqual("alchemy prod");
      expect(updated.labels).toMatchObject({ env: "prod", role: "aw" });
      expect(updated.violationNotificationsEnabled).toEqual(false);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
