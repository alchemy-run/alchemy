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

// Managed Microsoft AD takes 20-60 minutes to provision (~$0.40/hour).
// The API is enabled on the testing project; get-missing returns
// `NotFound`, and create with an invalid CIDR returns `BadRequest`
// (`CIDR "not-a-cidr" is invalid`). Set GCP_TEST_MANAGEDIDENTITIES=1
// to run the full lifecycle.
const runLifecycle =
  hasGcpCreds &&
  !process.env.FAST &&
  process.env.GCP_TEST_MANAGEDIDENTITIES === "1";
const project = process.env.GOOGLE_PROJECT_ID ?? "";

const waitUntilGone = (name: string) =>
  managedidentities.getProjectsLocationsGlobalDomains({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsGlobalDomains on a missing domain fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        managedidentities.getProjectsLocationsGlobalDomains({
          name: `projects/${project}/locations/global/domains/missing.alch.test`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      const page = yield* managedidentities
        .listProjectsLocationsGlobalDomains({
          parent: `projects/${project}/locations/global`,
          pageSize: 10,
        })
        .pipe(
          Effect.catchTag(["NotFound", "Forbidden"], () =>
            Effect.succeed({ domains: [] as const }),
          ),
        );
      expect(Array.isArray(page.domains ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || runLifecycle)(
  "create is rejected with a typed tag when Managed Microsoft AD is unavailable",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        stack.deploy(
          Effect.gen(function* () {
            return yield* GCP.Managedidentities.Domain("Ad", {
              reservedIpRange: "not-a-cidr",
              locations: ["us-central1"],
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
  "create, update, and delete a managed AD domain",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Managedidentities.Domain("Ad", {
            reservedIpRange: "172.16.0.0/24",
            locations: ["us-central1"],
            authorizedNetworks: ["default"],
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/domains/");
      expect(created.domainName).toEqual(expect.any(String));
      expect(created.location).toEqual("global");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched =
        yield* managedidentities.getProjectsLocationsGlobalDomains({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Managedidentities.Domain("Ad", {
            domainName: created.domainName,
            reservedIpRange: "172.16.0.0/24",
            locations: ["us-central1"],
            authorizedNetworks: ["default"],
            auditLogsEnabled: true,
            labels: { env: "prod", role: "identity" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.auditLogsEnabled).toEqual(true);
      expect(updated.labels).toMatchObject({ env: "prod", role: "identity" });

      const refetched =
        yield* managedidentities.getProjectsLocationsGlobalDomains({
          name: created.name,
        });
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("identity");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 240_000 },
);
