import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as biglake from "@distilled.cloud/gcp/biglake_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  hasGcpCreds,
  location,
  logLevel,
  probeTags,
  project,
  waitUntilGone,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsCatalogs on a missing catalog fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        biglake.getProjectsLocationsCatalogs({
          name: `projects/${project}/locations/${location}/catalogs/alchemy-missing`,
        }),
      );
      expect(probeTags).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "create, update, and delete a catalog",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Biglake.Catalog("Lake", {
            location,
          });
        }),
      );

      expect(created.name).toContain("/catalogs/");
      expect(created.catalogId).toEqual(expect.any(String));
      expect(created.location).toEqual(location);
      expect(created.project).toEqual(project);

      const fetched = yield* biglake.getProjectsLocationsCatalogs({
        name: created.name,
      });
      expect(fetched.name).toContain(created.catalogId);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Biglake.Catalog("Lake", {
            catalogId: created.catalogId,
            location,
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.catalogId).toEqual(created.catalogId);

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        biglake.getProjectsLocationsCatalogs({ name: created.name }),
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
