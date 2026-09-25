import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as firebaseapphosting from "@distilled.cloud/gcp/firebaseapphosting_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  hasGcpCreds,
  location,
  logLevel,
  missingBackend,
  probeTags,
  project,
  runLifecycle,
  serviceAccount,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const helloImage = "us-docker.pkg.dev/cloudrun/container/hello";

const waitUntilGone = (name: string) =>
  firebaseapphosting.getProjectsLocationsBackendsBuilds({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsBackendsBuilds on a missing build fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        firebaseapphosting.getProjectsLocationsBackendsBuilds({
          name: `${missingBackend()}/builds/alchemy-missing-build`,
        }),
      );
      expect(probeTags).toContain(error._tag);

      const page = yield* firebaseapphosting
        .listProjectsLocationsBackendsBuilds({
          parent: `projects/${project}/locations/-/backends/-`,
          pageSize: 10,
        })
        .pipe(
          Effect.catchTag(["NotFound", "Forbidden"], () =>
            Effect.succeed({ builds: [] as const }),
          ),
        );
      expect(Array.isArray(page.builds ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "create against a missing backend is rejected with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        stack.deploy(
          Effect.gen(function* () {
            return yield* GCP.Firebaseapphosting.BackendsBuild("Hello", {
              backend: missingBackend(),
              source: { container: { image: helloImage } },
              labels: { env: "test" },
            });
          }),
        ),
      );
      expect([
        ...probeTags,
        "GCP.Firebaseapphosting.OperationFailed",
        "GCP.Firebaseapphosting.ResourceNotResolved",
      ]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, verify, and delete a backend build",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const backend = yield* GCP.Firebaseapphosting.Backend("Web", {
            serviceAccount,
            servingLocality: "GLOBAL_ACCESS",
            displayName: "alchemy-test-build-backend",
            labels: { env: "test" },
          });
          const build = yield* GCP.Firebaseapphosting.BackendsBuild("Hello", {
            backend: backend.name,
            source: { container: { image: helloImage } },
            displayName: "alchemy-test-build",
            labels: { env: "test" },
          });
          return { backend, build };
        }),
      );

      expect(created.build.name).toContain("/builds/");
      expect(created.build.backend).toEqual(created.backend.name);
      expect(created.build.location).toEqual(location);
      expect(created.build.source?.container?.image).toEqual(helloImage);
      expect(created.build.labels).toMatchObject({ env: "test" });

      const fetched =
        yield* firebaseapphosting.getProjectsLocationsBackendsBuilds({
          name: created.build.name,
        });
      expect(fetched.name).toEqual(created.build.name);
      expect(fetched.source?.container?.image).toEqual(helloImage);
      expect(fetched.labels?.env).toEqual("test");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.build.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
