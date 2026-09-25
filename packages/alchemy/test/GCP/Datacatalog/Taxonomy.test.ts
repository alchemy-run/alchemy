import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as datacatalog from "@distilled.cloud/gcp/datacatalog_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  hasGcpCreds,
  location,
  logLevel,
  probeTags,
  project,
  runLifecycle,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  datacatalog.getProjectsLocationsTaxonomies({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsTaxonomies on a missing taxonomy fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        datacatalog.getProjectsLocationsTaxonomies({
          name: `projects/${project}/locations/${location}/taxonomies/alchemy-missing-taxonomy`,
        }),
      );
      expect(probeTags).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || runLifecycle)(
  "create is rejected with Forbidden when the Data Catalog API is disabled",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        datacatalog.createProjectsLocationsTaxonomies({
          parent: `projects/${project}/locations/${location}`,
          body: { displayName: "alchemy probe taxonomy" },
        }),
      );
      expect(error._tag).toEqual("Forbidden");
      expect(error.message).toContain("has not been used in project");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a taxonomy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Datacatalog.Taxonomy("Pii", {
            location,
            description: "taxonomy a",
            activatedPolicyTypes: ["FINE_GRAINED_ACCESS_CONTROL"],
          });
        }),
      );

      expect(created.name).toContain("/taxonomies/");
      expect(created.taxonomyId).toEqual(expect.any(String));
      expect(created.project).toEqual(project);
      expect(created.location).toEqual(location);
      expect(created.displayName).toEqual(expect.any(String));
      expect(created.description).toEqual("taxonomy a");
      expect(created.activatedPolicyTypes).toContain(
        "FINE_GRAINED_ACCESS_CONTROL",
      );

      const fetched = yield* datacatalog.getProjectsLocationsTaxonomies({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("taxonomy a");
      expect(fetched.displayName).toEqual(created.displayName);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Datacatalog.Taxonomy("Pii", {
            location,
            displayName: created.displayName,
            description: "taxonomy b",
            activatedPolicyTypes: ["FINE_GRAINED_ACCESS_CONTROL"],
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual(created.displayName);
      expect(updated.description).toEqual("taxonomy b");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
