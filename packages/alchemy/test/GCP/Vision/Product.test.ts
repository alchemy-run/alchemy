import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as vision from "@distilled.cloud/gcp/vision_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  hasGcpCreds,
  location,
  logLevel,
  project,
  runLifecycle,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  vision.getProjectsLocationsProducts({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.catchTag("Forbidden", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsProducts on a missing product fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        vision.getProjectsLocationsProducts({
          name: `projects/${project}/locations/${location}/products/alchemy-missing-product`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);
      if (error._tag === "Forbidden") {
        expect(error.message).toContain("Cloud Vision API has not been used");
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || process.env.GCP_TEST_VISION === "1")(
  "createProjectsLocationsProducts without Vision API fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        vision.createProjectsLocationsProducts({
          parent: `projects/${project}/locations/${location}`,
          productId: "alchemy-vision-probe",
          body: {
            displayName: "Alchemy probe",
            productCategory: "homegoods-v2",
          },
        }),
      );
      expect(error._tag).toEqual("Forbidden");
      expect(error.message).toContain("Cloud Vision API has not been used");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a product",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Vision.Product("Shoe", {
            location,
            displayName: "Trail runner",
            description: "mesh upper",
            productCategory: "apparel-v2",
            productLabels: [{ key: "color", value: "blue" }],
          });
        }),
      );

      expect(
        created.name.startsWith(
          `projects/${project}/locations/${location}/products/`,
        ),
      ).toEqual(true);
      expect(created.productId.length).toBeGreaterThan(0);
      expect(created.displayName).toEqual("Trail runner");
      expect(created.description).toEqual("mesh upper");
      expect(created.productCategory).toEqual("apparel-v2");
      expect(created.productLabels).toEqual([{ key: "color", value: "blue" }]);

      const fetched = yield* vision.getProjectsLocationsProducts({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toContain("[alchemy ");
      expect(fetched.productCategory).toEqual("apparel-v2");
      expect(
        (fetched.productLabels ?? []).some(
          (label) => label.key === "color" && label.value === "blue",
        ),
      ).toEqual(true);
      expect(
        (fetched.productLabels ?? []).some((label) =>
          (label.key ?? "").startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Vision.Product("Shoe", {
            location,
            productId: created.productId,
            displayName: "Trail runner v2",
            description: "knit upper",
            productCategory: "apparel-v2",
            productLabels: [
              { key: "color", value: "green" },
              { key: "size", value: "10" },
            ],
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("Trail runner v2");
      expect(updated.description).toEqual("knit upper");
      expect(updated.productLabels).toEqual([
        { key: "color", value: "green" },
        { key: "size", value: "10" },
      ]);

      const fetchedUpdate = yield* vision.getProjectsLocationsProducts({
        name: created.name,
      });
      expect(fetchedUpdate.displayName).toContain("Trail runner v2");
      expect(fetchedUpdate.description).toContain("knit upper");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
