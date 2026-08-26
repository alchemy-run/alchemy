import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as apihub from "@distilled.cloud/gcp/apihub_v1";
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
  hasGcpCreds && !process.env.FAST && !!process.env.GCP_TEST_APIHUB;
const project = process.env.GOOGLE_PROJECT_ID ?? "";
const location = "us-central1";
const resourceUri = "organizations/alchemy/environments/test/apis/orders";

const waitUntilGone = (name: string) =>
  apihub.getProjectsLocationsDeployments({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsDeployments on a missing deployment fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        apihub.getProjectsLocationsDeployments({
          name: `projects/${project}/locations/${location}/deployments/alchemy-missing-deployment`,
        }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an API Hub deployment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Apihub.Deployment("Orders", {
            location,
            displayName: "orders staging",
            description: "checkout proxy",
            resourceUri,
            endpoints: ["https://orders.example.com"],
          });
        }),
      );

      expect(created.name).toContain("/deployments/");
      expect(created.deploymentId).toEqual(expect.any(String));
      expect(created.location).toEqual(location);
      expect(created.displayName).toEqual("orders staging");
      expect(created.description).toEqual("checkout proxy");
      expect(created.resourceUri).toEqual(resourceUri);
      expect(created.endpoints).toEqual(["https://orders.example.com"]);

      const fetched = yield* apihub.getProjectsLocationsDeployments({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("checkout proxy");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Apihub.Deployment("Orders", {
            deploymentId: created.deploymentId,
            location,
            displayName: "orders staging",
            description: "checkout proxy (updated)",
            resourceUri,
            endpoints: [
              "https://orders.example.com",
              "https://orders-alt.example.com",
            ],
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("checkout proxy (updated)");
      expect(updated.endpoints).toEqual([
        "https://orders.example.com",
        "https://orders-alt.example.com",
      ]);

      const fetchedUpdate = yield* apihub.getProjectsLocationsDeployments({
        name: created.name,
      });
      expect(fetchedUpdate.description).toContain("checkout proxy (updated)");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
