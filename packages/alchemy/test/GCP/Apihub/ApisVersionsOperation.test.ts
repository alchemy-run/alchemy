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

const runLifecycle = hasGcpCreds && !process.env.FAST;
const project = process.env.GOOGLE_PROJECT_ID ?? "";
const location = "us-central1";

const waitUntilGone = (name: string) =>
  apihub.getProjectsLocationsApisVersionsOperations({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsApisVersionsOperations on a missing operation fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        apihub.getProjectsLocationsApisVersionsOperations({
          name: `projects/${project}/locations/${location}/apis/alchemy-missing/versions/v1/operations/list`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an API Hub operation",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const api = yield* GCP.Apihub.Api("Pets", {
            location,
            displayName: "pets",
          });
          const version = yield* GCP.Apihub.ApisVersion("V1", {
            api: api.name,
            location,
            displayName: "v1",
          });
          const operation = yield* GCP.Apihub.ApisVersionsOperation(
            "ListPets",
            {
              version: version.name,
              location,
              details: {
                httpOperation: {
                  method: "GET",
                  path: { path: "/pets" },
                },
                description: "list pets",
              },
            },
          );
          return { api, version, operation };
        }),
      );

      expect(created.operation.name).toContain("/operations/");
      expect(created.operation.version).toEqual(created.version.name);
      expect(created.operation.details?.httpOperation?.method).toEqual("GET");
      expect(created.operation.details?.httpOperation?.path?.path).toEqual(
        "/pets",
      );
      expect(created.operation.details?.description).toEqual("list pets");

      const fetched = yield* apihub.getProjectsLocationsApisVersionsOperations({
        name: created.operation.name,
      });
      expect(fetched.name).toEqual(created.operation.name);
      expect(fetched.details?.description).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const api = yield* GCP.Apihub.Api("Pets", {
            apiId: created.api.apiId,
            location,
            displayName: "pets",
          });
          const version = yield* GCP.Apihub.ApisVersion("V1", {
            api: api.name,
            versionId: created.version.versionId,
            location,
            displayName: "v1",
          });
          const operation = yield* GCP.Apihub.ApisVersionsOperation(
            "ListPets",
            {
              version: version.name,
              apiOperationId: created.operation.apiOperationId,
              location,
              details: {
                httpOperation: {
                  method: "GET",
                  path: { path: "/animals" },
                },
                description: "list animals",
                deprecated: true,
              },
            },
          );
          return { api, version, operation };
        }),
      );

      expect(updated.operation.name).toEqual(created.operation.name);
      expect(updated.operation.details?.httpOperation?.path?.path).toEqual(
        "/animals",
      );
      expect(updated.operation.details?.description).toEqual("list animals");
      expect(updated.operation.details?.deprecated).toEqual(true);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.operation.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
