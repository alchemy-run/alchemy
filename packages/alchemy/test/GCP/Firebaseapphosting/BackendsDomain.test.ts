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

const waitUntilGone = (name: string) =>
  firebaseapphosting.getProjectsLocationsBackendsDomains({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsBackendsDomains on a missing domain fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        firebaseapphosting.getProjectsLocationsBackendsDomains({
          name: `${missingBackend()}/domains/alchemy-missing.example.com`,
        }),
      );
      expect(probeTags).toContain(error._tag);

      const page = yield* firebaseapphosting
        .listProjectsLocationsBackendsDomains({
          parent: `projects/${project}/locations/-/backends/-`,
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

test.provider.skipIf(!hasGcpCreds)(
  "create against a missing backend is rejected with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        stack.deploy(
          Effect.gen(function* () {
            return yield* GCP.Firebaseapphosting.BackendsDomain("Www", {
              backend: missingBackend(),
              domainId: "alchemy-missing.example.com",
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
  "create, update, and delete a backend domain",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const backend = yield* GCP.Firebaseapphosting.Backend("Web", {
            serviceAccount,
            servingLocality: "GLOBAL_ACCESS",
            displayName: "alchemy-test-domain-backend",
            labels: { env: "test" },
          });
          const domain = yield* GCP.Firebaseapphosting.BackendsDomain("Www", {
            backend: backend.name,
            displayName: "alchemy-test-domain",
            disabled: true,
            labels: { env: "test" },
          });
          return { backend, domain };
        }),
      );

      expect(created.domain.name).toContain("/domains/");
      expect(created.domain.backend).toEqual(created.backend.name);
      expect(created.domain.location).toEqual(location);
      expect(created.domain.disabled).toEqual(true);
      expect(created.domain.displayName).toEqual("alchemy-test-domain");
      expect(created.domain.labels).toMatchObject({ env: "test" });

      const fetched =
        yield* firebaseapphosting.getProjectsLocationsBackendsDomains({
          name: created.domain.name,
        });
      expect(fetched.name).toEqual(created.domain.name);
      expect(fetched.displayName).toEqual("alchemy-test-domain");
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const backend = yield* GCP.Firebaseapphosting.Backend("Web", {
            backendId: created.backend.backendId,
            serviceAccount,
            servingLocality: "GLOBAL_ACCESS",
            displayName: "alchemy-test-domain-backend",
            labels: { env: "test" },
          });
          const domain = yield* GCP.Firebaseapphosting.BackendsDomain("Www", {
            domainId: created.domain.domainId,
            backend: backend.name,
            displayName: "alchemy-prod-domain",
            disabled: true,
            labels: { env: "prod", role: "web" },
          });
          return domain;
        }),
      );

      expect(updated.name).toEqual(created.domain.name);
      expect(updated.displayName).toEqual("alchemy-prod-domain");
      expect(updated.labels).toMatchObject({ env: "prod", role: "web" });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.domain.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
