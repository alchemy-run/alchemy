import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as iam from "@distilled.cloud/gcp/unstable/iam_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const project = process.env.GOOGLE_PROJECT_ID ?? "";
const hasGcpCreds = !!(
  project &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

const waitUntilGone = (name: string) =>
  iam.getProjectsServiceAccounts({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "create, update, and delete a service account",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.IAM.ServiceAccount("Worker", {
            displayName: "Alchemy worker",
            description: "test account",
          });
        }),
      );

      expect(created.accountId).toEqual(expect.any(String));
      expect(created.project).toEqual(project);
      expect(created.email).toEqual(
        `${created.accountId}@${project}.iam.gserviceaccount.com`,
      );
      expect(created.name).toEqual(
        `projects/${project}/serviceAccounts/${created.email}`,
      );
      expect(created.displayName).toEqual("Alchemy worker");
      expect(created.description).toEqual("test account");
      expect(created.uniqueId).toEqual(expect.any(String));

      const fetched = yield* iam.getProjectsServiceAccounts({
        name: created.name,
      });
      expect(fetched.email).toEqual(created.email);
      expect(fetched.displayName).toEqual("Alchemy worker");
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("test account");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.IAM.ServiceAccount("Worker", {
            accountId: created.accountId,
            displayName: "Alchemy worker (prod)",
            description: "updated account",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.uniqueId).toEqual(created.uniqueId);
      expect(updated.displayName).toEqual("Alchemy worker (prod)");
      expect(updated.description).toEqual("updated account");

      const fetchedUpdate = yield* iam.getProjectsServiceAccounts({
        name: created.name,
      });
      expect(fetchedUpdate.displayName).toEqual("Alchemy worker (prod)");
      expect(fetchedUpdate.description).toContain("updated account");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
