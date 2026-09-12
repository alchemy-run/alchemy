import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as apigee from "@distilled.cloud/gcp/apigee_v1";
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
  hasGcpCreds && !!process.env.GCP_TEST_APIGEE && !process.env.FAST;

const project = process.env.GOOGLE_PROJECT_ID ?? "";
const org = `organizations/${project}`;

// Empty `proxies/` directory zip used as archive payload.
const ARCHIVE_ZIP =
  "UEsDBAoAAAAAAIdO4kgAAAAAAAAAAAAAAAAJAAAAcHJveGllcy9QSwECFAAKAAAAAACHTuJIAAAAAAAAAAAAAAAACTAAAAAAAAAAABAAAAAAAAAAcHJveGllcy9QSwUGAAAAAAEAAQA3AAAAJwAAAAAA";

const waitUntilGone = (name: string) =>
  apigee.getOrganizationsEnvironmentsArchiveDeployments({ name }).pipe(
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
  "getOrganizationsEnvironmentsArchiveDeployments on a missing archive fails with NotFound or Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        apigee.getOrganizationsEnvironmentsArchiveDeployments({
          name: `${org}/environments/alchemy-missing/archiveDeployments/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an archive deployment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const environment = yield* GCP.Apigee.Environment("Runtime", {
            displayName: "runtime",
          });
          const archive = yield* GCP.Apigee.EnvironmentsArchiveDeployment(
            "Bundle",
            {
              environment: environment.environmentId,
              archiveZip: ARCHIVE_ZIP,
              labels: { env: "test" },
            },
          );
          return { environment, archive };
        }),
      );

      expect(created.archive.archiveDeploymentId).toEqual(expect.any(String));
      expect(created.archive.environmentId).toEqual(
        created.environment.environmentId,
      );
      expect(created.archive.labels).toMatchObject({ env: "test" });

      const fetched =
        yield* apigee.getOrganizationsEnvironmentsArchiveDeployments({
          name: created.archive.name,
        });
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const environment = yield* GCP.Apigee.Environment("Runtime", {
            environmentId: created.environment.environmentId,
            displayName: "runtime",
          });
          const archive = yield* GCP.Apigee.EnvironmentsArchiveDeployment(
            "Bundle",
            {
              environment: environment.environmentId,
              archiveDeploymentId: created.archive.archiveDeploymentId,
              archiveZip: ARCHIVE_ZIP,
              labels: { env: "prod" },
            },
          );
          return { environment, archive };
        }),
      );

      expect(updated.archive.name).toEqual(created.archive.name);
      expect(updated.archive.labels).toMatchObject({ env: "prod" });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.archive.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
