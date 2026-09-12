import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as drivelabels from "@distilled.cloud/gcp/drivelabels_v2";
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

const waitUntilGone = (name: string) =>
  drivelabels
    .getLabels({
      name,
      view: "LABEL_VIEW_FULL",
    })
    .pipe(
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
  "getLabels on a missing label fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        drivelabels.getLabels({
          name: "labels/alchemyMissingLabel000",
          view: "LABEL_VIEW_FULL",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.FAST)(
  "create, update, and delete a Drive label",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const access = yield* drivelabels
        .createLabels({
          body: {
            labelType: "SHARED",
            properties: { title: "Alchemy Drive Labels Probe" },
          },
        })
        .pipe(
          Effect.map((label) => ({ ok: true as const, label })),
          Effect.catchTag(["Forbidden", "NotFound", "BadRequest"], (error) =>
            Effect.succeed({ ok: false as const, error: error._tag }),
          ),
        );
      if (!access.ok) {
        expect(["Forbidden", "NotFound", "BadRequest"]).toContain(access.error);
        yield* stack.destroy();
        return;
      }
      const probeName =
        access.label.name ??
        (access.label.id ? `labels/${access.label.id}` : "");
      if (probeName.length > 0) {
        yield* drivelabels
          .deleteLabels({ name: probeName })
          .pipe(
            Effect.catchTag(
              ["NotFound", "Forbidden", "BadRequest", "Conflict"],
              () => Effect.void,
            ),
          );
      }

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Drivelabels.Label("Classification", {
            title: "Classification",
            description: "Sensitivity of the Drive item",
            fields: [{ displayName: "Level", type: "TEXT" }],
          });
        }),
      );

      expect(created.name).toMatch(/^labels\//);
      expect(created.labelId.length).toBeGreaterThan(0);
      expect(created.title).toEqual("Classification");
      expect(created.description).toEqual("Sensitivity of the Drive item");
      expect(created.labelType).toEqual("SHARED");
      expect(
        created.fields.some((field) => field.displayName === "Level"),
      ).toEqual(true);

      const fetched = yield* drivelabels.getLabels({
        name: created.name,
        view: "LABEL_VIEW_FULL",
      });
      expect(fetched.id).toEqual(created.labelId);
      expect(fetched.properties?.title).toEqual("Classification");
      expect(fetched.properties?.description).toContain("[alchemy ");
      expect(fetched.properties?.description).toContain(
        "Sensitivity of the Drive item",
      );

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Drivelabels.Label("Classification", {
            labelId: created.labelId,
            title: "Sensitivity",
            description: "updated",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.labelId).toEqual(created.labelId);
      expect(updated.title).toEqual("Sensitivity");
      expect(updated.description).toEqual("updated");

      const fetchedUpdate = yield* drivelabels.getLabels({
        name: created.name,
        view: "LABEL_VIEW_FULL",
      });
      expect(fetchedUpdate.properties?.title).toEqual("Sensitivity");
      expect(fetchedUpdate.properties?.description).toContain("[alchemy ");
      expect(fetchedUpdate.properties?.description).toContain("updated");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
